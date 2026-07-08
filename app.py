import argparse
import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import queue
import traceback
from dataclasses import dataclass
from pathlib import Path

from scripts.process_guard import cleanup_process_tree, guard_process, popen_creationflags
from scripts.verify_xpano_output import verify_output
from scripts.xpano_tracks import build_manifest, load_manifest, validate_manifest
from scripts.colmap_backend import (
    ColmapBackendConfig,
    build_colmap_plan,
    colmap_config_for_density_preset,
    find_sparse_model_path,
    publish_colmap_output,
    run_colmap_plan,
    apply_up_axis_rotation,
)


APP_TITLE = "xPano 多相机轨重建"

tk = None
filedialog = None
messagebox = None
ttk = None
Image = None
ImageTk = None


def load_gui_dependencies():
    global tk, filedialog, messagebox, ttk, Image, ImageTk
    if tk is not None:
        return
    import tkinter as _tk
    from tkinter import filedialog as _filedialog
    from tkinter import messagebox as _messagebox
    from tkinter import ttk as _ttk
    from PIL import Image as _Image
    from PIL import ImageTk as _ImageTk

    tk = _tk
    filedialog = _filedialog
    messagebox = _messagebox
    ttk = _ttk
    Image = _Image
    ImageTk = _ImageTk


@dataclass
class JobConfig:
    input_video: Path
    output_dir: Path
    seconds_per_frame: float
    max_frames: int
    metashape_exe: str
    overwrite_generated: bool = True


@dataclass
class MaterialTrack:
    track_type: str
    label: str
    paths: list
    # Optional (start, end) trim window in seconds for panoramic video tracks.
    trim: tuple = None
    seconds_per_frame: float = None
    max_frames: int = None


@dataclass
class MultiTrackJobConfig:
    panorama_videos: list
    standard_photo_tracks: list
    aerial_photo_tracks: list
    output_dir: Path
    seconds_per_frame: float
    max_frames: int
    metashape_exe: str
    overwrite_generated: bool = True
    manifest_path: Path = None
    backend: str = "metashape"
    colmap_exe: str = ""
    colmap_density_preset: str = "stable"
    colmap_matcher: str = "sequential"
    colmap_use_gpu: bool = False
    colmap_max_image_size: int = 1600
    colmap_max_num_features: int = 4096
    metashape_keypoint_limit: int = 40000
    metashape_tiepoint_limit: int = 0
    up_axis: str = "+Y"
    skip_extract: bool = False
    run_lichtfield: bool = False
    lichtfield_exe: str = ""
    lichtfield_point_count: int = 0
    lichtfield_bilateral_grid: int = 0
    run_lfs_densify: bool = False
    lfs_densify_python: str = ""
    lfs_densify_plugin: str = ""
    lfs_densify_roma: str = "fast"
    lfs_densify_num_refs: float = 8.0
    lfs_densify_max_points: int = 0


def material_tracks_to_job_config(
    tracks,
    output_dir,
    seconds_per_frame,
    max_frames,
    metashape_exe,
    overwrite_generated=True,
    **kwargs,
):
    panorama_videos = []
    standard_photo_tracks = []
    aerial_photo_tracks = []

    for track in tracks:
        paths = [Path(path).resolve() for path in track.paths]
        if not paths:
            raise ValueError(f"Material track {track.label or track.track_type} must contain at least one path")
        if track.track_type == "panorama_video":
            # Carry the optional trim window so downstream ffmpeg can seek.
            start, end = (track.trim or (0.0, 0.0))
            track_seconds_per_frame = seconds_per_frame if track.seconds_per_frame is None else float(track.seconds_per_frame)
            track_max_frames = max_frames if track.max_frames is None else int(track.max_frames)
            if track_seconds_per_frame <= 0:
                raise ValueError(f"Panorama track {track.label or track.track_type} seconds_per_frame must be greater than 0")
            if track_max_frames < 0:
                raise ValueError(f"Panorama track {track.label or track.track_type} max_frames must be greater than or equal to 0")
            for path in paths:
                panorama_videos.append({
                    "path": path,
                    "start": float(start),
                    "end": float(end),
                    "seconds_per_frame": track_seconds_per_frame,
                    "max_frames": track_max_frames,
                })
        elif track.track_type == "standard_photos":
            standard_photo_tracks.append((track.label, paths))
        elif track.track_type == "aerial_photos":
            aerial_photo_tracks.append((track.label, paths))
        else:
            raise ValueError(f"Unsupported material track type: {track.track_type}")

    return MultiTrackJobConfig(
        panorama_videos=panorama_videos,
        standard_photo_tracks=standard_photo_tracks,
        aerial_photo_tracks=aerial_photo_tracks,
        output_dir=Path(output_dir).resolve(),
        seconds_per_frame=seconds_per_frame,
        max_frames=max_frames,
        metashape_exe=metashape_exe,
        overwrite_generated=overwrite_generated,
        **kwargs,
    )


def locate_metashape():
    candidates = []
    explicit = os.environ.get("XPANO_METASHAPE")
    if explicit and Path(explicit).exists():
        return explicit
    env_path = os.environ.get("Path", "")
    for item in env_path.split(os.pathsep):
        item = item.strip()
        if not item:
            continue
        exe = Path(item) / "metashape.exe"
        if exe.exists():
            candidates.append(str(exe))
    for item in [
        r"E:\FastProgram\Metashape\metashape.exe",
        r"C:\Program Files\Agisoft\Metashape Pro\metashape.exe",
        r"C:\Program Files\Agisoft\Metashape\metashape.exe",
    ]:
        exe = Path(item)
        if exe.exists():
            candidates.append(str(exe))
    if candidates:
        return candidates[0]
    return "metashape.exe"


def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    return path


def generated_output_paths(output_dir: Path, preserve_extract=False):
    paths = [output_dir / "images", output_dir / "sparse", output_dir / "colmap_images", output_dir / "database.db", output_dir / "colmap_images.json"]
    if preserve_extract:
        paths.extend([output_dir / "workspace" / "alignment_summary.txt", output_dir / "workspace" / "run_summary.json"])
    else:
        paths.insert(0, output_dir / "workspace")
    return paths


def clear_generated_outputs(output_dir: Path, log_cb, preserve_extract=False):
    for path in generated_output_paths(output_dir, preserve_extract=preserve_extract):
        if path.exists():
            log_cb(f"清理旧输出: {path}")
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()


def _norm_path(path):
    return str(Path(path).resolve()).replace("\\", "/").rstrip("/").casefold()


def _job_video_specs(job):
    specs = []
    for item in getattr(job, "panorama_videos", []) or []:
        if isinstance(item, dict):
            specs.append((
                _norm_path(item["path"]),
                round(float(item.get("start", 0.0) or 0.0), 3),
                round(float(item.get("end", 0.0) or 0.0), 3),
                round(float(item.get("seconds_per_frame", getattr(job, "seconds_per_frame", 1.0)) or 1.0), 6),
                int(item.get("max_frames", getattr(job, "max_frames", 0)) or 0),
            ))
        else:
            specs.append((
                _norm_path(item),
                0.0,
                0.0,
                round(float(getattr(job, "seconds_per_frame", 1.0) or 1.0), 6),
                int(getattr(job, "max_frames", 0) or 0),
            ))
    return sorted(specs)


def _manifest_video_specs(manifest):
    specs = []
    for track in manifest.get("tracks", []):
        if track.get("track_type") != "panorama_video":
            continue
        paths = track.get("source_paths") or []
        if not paths:
            continue
        specs.append((
            _norm_path(paths[0]),
            round(float(track.get("start_time", 0.0) or 0.0), 3),
            round(float(track.get("end_time", 0.0) or 0.0), 3),
            round(float(track.get("seconds_per_frame", 1.0) or 1.0), 6),
            int(track.get("max_frames", 0) or 0),
        ))
    return sorted(specs)


def _job_photo_specs(job, attr):
    specs = []
    for label, paths in getattr(job, attr, []) or []:
        specs.append((str(label), sorted(_norm_path(path) for path in paths)))
    return sorted(specs)


def _manifest_photo_specs(manifest, track_type):
    specs = []
    for track in manifest.get("tracks", []):
        if track.get("track_type") != track_type:
            continue
        specs.append((str(track.get("device_label", "")), sorted(_norm_path(path) for path in track.get("source_paths", []))))
    return sorted(specs)


def existing_extract_manifest(job):
    manifest_path = job.output_dir / "workspace" / "xpano_manifest.json"
    if not manifest_path.exists():
        return None
    try:
        manifest = validate_manifest(load_manifest(manifest_path))
    except Exception:
        return None
    if _manifest_video_specs(manifest) != _job_video_specs(job):
        return None
    if _manifest_photo_specs(manifest, "standard_photos") != _job_photo_specs(job, "standard_photo_tracks"):
        return None
    if _manifest_photo_specs(manifest, "aerial_photos") != _job_photo_specs(job, "aerial_photo_tracks"):
        return None
    return manifest_path


PROGRESS_EXTRACT_START = 4.0
PROGRESS_EXTRACT_END = 30.0
PROGRESS_ALIGN_END = 86.0
PROGRESS_EXPORT_END = 100.0


def _phase_percent_from_overall(phase, overall):
    if phase == "extract":
        span = PROGRESS_EXTRACT_END - PROGRESS_EXTRACT_START
        return max(0.0, min(100.0, (overall - PROGRESS_EXTRACT_START) / span * 100.0))
    if phase == "align":
        span = PROGRESS_ALIGN_END - PROGRESS_EXTRACT_END
        return max(0.0, min(100.0, (overall - PROGRESS_EXTRACT_END) / span * 100.0))
    if phase == "export":
        span = PROGRESS_EXPORT_END - PROGRESS_ALIGN_END
        return max(0.0, min(100.0, (overall - PROGRESS_ALIGN_END) / span * 100.0))
    if phase == "complete":
        return 100.0
    return 0.0


def _scale_progress(value, src_start, src_end, dst_start, dst_end):
    if src_end == src_start:
        return dst_end
    ratio = (float(value) - float(src_start)) / (float(src_end) - float(src_start))
    ratio = max(0.0, min(1.0, ratio))
    return float(dst_start) + ratio * (float(dst_end) - float(dst_start))


def emit_pipeline_progress(progress_cb, *, phase, percent, message, stage=None, phase_percent=None):
    percent = max(0.0, min(100.0, float(percent)))
    phase_percent = _phase_percent_from_overall(phase, percent) if phase_percent is None else phase_percent
    payload = {
        "phase": phase,
        "stage": stage or phase,
        "percent": int(round(percent)),
        "phase_percent": int(round(max(0.0, min(100.0, float(phase_percent))))),
        "message": message,
    }
    if getattr(progress_cb, "supports_structured", False):
        progress_cb(payload)
    else:
        progress_cb(percent)


def _resolve_metashape_runner(metashape_exe):
    exe = Path(metashape_exe)
    if exe.name.lower() == "metashape.exe" or not exe.exists():
        return str(exe)
    if "portable" not in exe.name.lower():
        return str(exe)

    roots = [exe.parent]
    direct_candidates = [
        exe.parent / "App" / "Metashape" / "metashape.exe",
        exe.parent / "App" / "Metashape Pro" / "metashape.exe",
        exe.parent / "App" / "MetashapePro" / "metashape.exe",
        exe.parent / "App" / "Agisoft Metashape" / "metashape.exe",
        exe.parent / "App" / "Agisoft Metashape Pro" / "metashape.exe",
        exe.parent / "App" / "metashape.exe",
        exe.parent / "Metashape" / "metashape.exe",
    ]
    for candidate in direct_candidates:
        if candidate.exists() and candidate.resolve() != exe.resolve():
            return str(candidate)

    # Portable launchers often keep the real binary one or two folders below
    # the wrapper. Keep the search local so an accidentally broad path is cheap.
    try:
        for candidate in roots[0].rglob("metashape.exe"):
            if candidate.exists() and candidate.resolve() != exe.resolve():
                return str(candidate)
    except Exception:
        pass
    return str(exe)


def _metashape_python_candidates(metashape_exe):
    exe = Path(metashape_exe)
    roots = [exe.parent]
    if exe.parent.name.lower() in {"metashape", "metashape pro", "metashapepro"}:
        roots.append(exe.parent.parent)
    candidates = []
    for root in roots:
        candidates.extend([
            root / "python" / "python.exe",
            root / "Python" / "python.exe",
            root / "python.exe",
            root / "App" / "Python" / "python.exe",
            root / "App" / "python" / "python.exe",
            root / "App" / "Metashape" / "python" / "python.exe",
            root / "App" / "Metashape Pro" / "python" / "python.exe",
        ])
    seen = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.exists():
            return candidate
    return None


def _ensure_metashape_python_deps(metashape_exe, log_cb):
    meta_python = _metashape_python_candidates(metashape_exe)
    if not meta_python:
        log_cb("WARN: Metashape Python not found; dependency check skipped")
        return

    version = subprocess.run(
        [str(meta_python), "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=popen_creationflags(),
    )
    if version.stdout.strip():
        log_cb(f"Metashape Python version: {version.stdout.strip()}")

    check_code = "import cv2, numpy; print('ok')"
    check = subprocess.run(
        [str(meta_python), "-c", check_code],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=popen_creationflags(),
    )
    if check.returncode == 0:
        log_cb("Metashape Python dependencies ready")
        return

    req = Path(__file__).parent / "metashape_requirements.txt"
    if not req.exists():
        raise RuntimeError(f"Missing metashape requirements: {req}")
    install_attempts = [
        ("Tsinghua", ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--trusted-host", "pypi.tuna.tsinghua.edu.cn"]),
        ("Aliyun", ["-i", "https://mirrors.aliyun.com/pypi/simple/", "--trusted-host", "mirrors.aliyun.com"]),
        ("PyPI", []),
    ]
    install = None
    failed_outputs = []
    for source_name, index_args in install_attempts:
        log_cb(f"Installing Metashape Python dependencies from {source_name}")
        install = subprocess.run(
            [
                str(meta_python),
                "-m",
                "pip",
                "install",
                "--timeout",
                "120",
                *index_args,
                "-r",
                str(req),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=popen_creationflags(),
        )
        if install.stdout.strip():
            for line in install.stdout.splitlines()[-24:]:
                if line.strip():
                    log_cb(line.strip())
        if install.returncode == 0:
            break
        failed_outputs.append(f"{source_name}: {install.stdout.strip()}")
    if install is None or install.returncode != 0:
        tail_parts = []
        for item in failed_outputs:
            lines = item.splitlines()
            tail_parts.append("\n".join(lines[-8:])[:1200] if lines else item[:1200])
        tail = "\n".join(tail_parts)
        raise RuntimeError(
            "Metashape Python dependency installation failed. "
            f"Python={meta_python}; requirements={req}\n{tail}"
        )

    verify = subprocess.run(
        [str(meta_python), "-c", check_code],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=popen_creationflags(),
    )
    if verify.returncode != 0:
        raise RuntimeError(f"Metashape Python dependencies still unavailable: {verify.stdout.strip()}")
    log_cb("Metashape Python dependencies ready")


def write_run_summary(job: MultiTrackJobConfig):
    image_dir = job.output_dir / "images"
    sparse_dir = job.output_dir / "sparse" / "0"
    frames_dir = job.output_dir / "workspace" / "frames"
    manifest_path = getattr(job, "manifest_path", None) or job.output_dir / "workspace" / "xpano_manifest.json"
    manifest_path = Path(manifest_path)
    manifest = load_manifest(manifest_path) if manifest_path.exists() else {"tracks": []}
    export_verification = verify_output(job.output_dir, expect_single_sparse=True)
    input_videos = [
        str(item["path"] if isinstance(item, dict) else item)
        for item in getattr(job, "panorama_videos", [])
    ]
    if not input_videos and hasattr(job, "input_video"):
        input_videos = [str(job.input_video)]
    summary = {
        "workflow": "xpano_multi_track",
        "input_video": input_videos[0] if len(input_videos) == 1 else "",
        "input_videos": input_videos,
        "output_dir": str(job.output_dir),
        "seconds_per_frame": job.seconds_per_frame,
        "max_frames": job.max_frames,
        "track_count": len(manifest.get("tracks", [])),
        "tracks": [
            {
                "track_id": track.get("track_id"),
                "track_type": track.get("track_type"),
                "device_label": track.get("device_label"),
                "frame_count": len(track.get("frames", [])),
                "photo_count": len(track.get("photos", [])),
                "photo_sensor_count": len(track.get("photo_sensors", [])),
            }
            for track in manifest.get("tracks", [])
        ],
        "manifest": str(manifest_path),
        "export_verification": export_verification,
        "frames_jpg": len(list(frames_dir.rglob("*.jpg"))) if frames_dir.exists() else 0,
        "cubemap_images": len(list(image_dir.glob("*.jpg"))) if image_dir.exists() else 0,
        "colmap_bins": {
            name: (sparse_dir / name).stat().st_size if (sparse_dir / name).exists() else 0
            for name in ["cameras.bin", "images.bin", "points3D.bin"]
        },
        "alignment_summary": str(job.output_dir / "workspace" / "alignment_summary.txt"),
    }
    (job.output_dir / "workspace" / "run_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


_active_proc: subprocess.Popen | None = None
_active_job = None


def _clear_metashape_crash_state(metashape_exe=None):
    """Delete Metashape's crash-recovery state so a previous forced kill
    doesn't trigger a blocking dialog on the next headless start."""
    import glob as _glob
    candidates = []
    roots = []
    appdata = os.environ.get("APPDATA", "")
    local_appdata = os.environ.get("LOCALAPPDATA", "")
    for base in (appdata, local_appdata):
        if not base:
            continue
        # Metashape stores document state and crash markers in its profile
        for folder in ("Agisoft",):
            root = Path(base) / folder
            if not root.exists():
                continue
            roots.append(root)
    if metashape_exe:
        exe = Path(metashape_exe)
        if exe.exists():
            roots.extend([
                exe.parent,
                exe.parent / "Data",
                exe.parent / "UserData",
                exe.parent / "Profile",
                exe.parent / "AppData",
                exe.parent / "Agisoft",
            ])

    seen = set()
    for root in roots:
        if not root.exists():
            continue
        # Remove stale document state / lock / recovery files. These patterns
        # intentionally target files only, not settings folders.
        for pattern in ("**/document_state*", "**/crash_*", "**/*crash*", "**/recovery*", "**/*recover*", "**/*.lock", "**/*_state.xml"):
            for path in _glob.glob(str(root / pattern), recursive=True):
                key = str(Path(path).resolve()).casefold()
                if key not in seen:
                    seen.add(key)
                    candidates.append(path)
    for path in candidates:
        try:
            target = Path(path)
            if target.is_file() and target.stat().st_size <= 64 * 1024 * 1024:
                target.unlink()
        except Exception:
            pass


def _cleanup_subprocess():
    """Kill the active alignment subprocess, if any, on exit or signal."""
    global _active_proc, _active_job
    if _active_proc is not None:
        try:
            cleanup_process_tree(_active_proc, _active_job)
        except Exception:
            pass
        _active_proc = None
        _active_job = None


def _signal_handler(signum, _frame):
    _cleanup_subprocess()
    sys.exit(128 + signum)


atexit.register(_cleanup_subprocess)
signal.signal(signal.SIGTERM, _signal_handler)
signal.signal(signal.SIGINT, _signal_handler)


def run_multi_track_pipeline(job: MultiTrackJobConfig, progress_cb, preview_cb, log_cb):
    reusable_manifest = None if job.manifest_path else existing_extract_manifest(job)
    if job.skip_extract:
        if reusable_manifest:
            job.manifest_path = reusable_manifest
        else:
            log_cb("WARN: --skip-extract 已设置但现有抽帧结果与当前参数不匹配，将重新抽帧")
            job.skip_extract = False
    elif reusable_manifest:
        job.skip_extract = True
        job.manifest_path = reusable_manifest
        log_cb("检测到已有抽帧结果，跳过抽帧并复用缓存")

    if job.skip_extract and job.manifest_path:
        if job.overwrite_generated:
            clear_generated_outputs(job.output_dir, log_cb, preserve_extract=True)
        manifest_path = Path(job.manifest_path).resolve()
        validate_manifest(load_manifest(manifest_path))
        log_cb("跳过抽帧，复用已有影像帧")
        emit_pipeline_progress(
            progress_cb,
            phase="extract",
            stage="extract.cache_reuse",
            percent=PROGRESS_EXTRACT_END,
            phase_percent=100,
            message="复用已有抽帧，直接进入对齐",
        )
    elif job.manifest_path:
        if job.overwrite_generated:
            clear_generated_outputs(job.output_dir, log_cb, preserve_extract=True)
        log_cb("载入现有影像清单")
        manifest_path = Path(job.manifest_path).resolve()
        validate_manifest(load_manifest(manifest_path))
        emit_pipeline_progress(
            progress_cb,
            phase="extract",
            stage="extract.manifest",
            percent=PROGRESS_EXTRACT_END,
            phase_percent=100,
            message="已载入现有影像清单",
        )
    else:
        if job.overwrite_generated:
            clear_generated_outputs(job.output_dir, log_cb)
        log_cb("开始抽帧")
        emit_pipeline_progress(
            progress_cb,
            phase="extract",
            stage="extract.start",
            percent=PROGRESS_EXTRACT_START,
            phase_percent=0,
            message="开始抽取视频帧",
        )
        # Track cumulative extract progress across all videos so the bar never goes backwards
        extract_state = {"done": 0, "active_cur": 0, "active_total": 1}
        total_tracks = len(job.panorama_videos or [])
        tracks_done = [0]

        def extract_progress_cb(cur, total):
            s = extract_state
            if cur < s["active_cur"] and s["active_cur"] > 0:
                tracks_done[0] += 1
            s["active_cur"] = cur
            s["active_total"] = max(total, 1)
            if total_tracks > 0:
                share = (PROGRESS_EXTRACT_END - PROGRESS_EXTRACT_START) / max(total_tracks, 1)
                done_pct = tracks_done[0] * share
                current_pct = share * (cur / max(total, 1))
                pct = PROGRESS_EXTRACT_START + done_pct + current_pct
            else:
                pct = PROGRESS_EXTRACT_START
            overall = min(pct, PROGRESS_EXTRACT_END)
            emit_pipeline_progress(
                progress_cb,
                phase="extract",
                stage="extract.frames",
                percent=overall,
                phase_percent=_phase_percent_from_overall("extract", overall),
                message=f"已抽取 {cur}/{total} 帧",
            )

        _, manifest_path = build_manifest(
            output_dir=job.output_dir,
            panorama_videos=job.panorama_videos,
            standard_photo_tracks=job.standard_photo_tracks,
            aerial_photo_tracks=job.aerial_photo_tracks,
            seconds_per_frame=job.seconds_per_frame,
            max_frames=job.max_frames,
            preview_cb=preview_cb,
            progress_cb=extract_progress_cb,
            log_cb=log_cb,
        )
        job.manifest_path = manifest_path
        emit_pipeline_progress(
            progress_cb,
            phase="extract",
            stage="extract.complete",
            percent=PROGRESS_EXTRACT_END,
            phase_percent=100,
            message="抽帧完成，准备开始对齐",
        )

    if job.backend == "colmap":
        log_cb("开始 COLMAP 自动处理")
        manifest = load_manifest(manifest_path)
        colmap_preset = getattr(job, "colmap_density_preset", "stable")
        colmap_cfg = colmap_config_for_density_preset(colmap_preset, colmap_exe=job.colmap_exe)
        colmap_cfg = ColmapBackendConfig(
            **{
                **colmap_cfg.__dict__,
                "use_gpu": getattr(job, "colmap_use_gpu", False),
                "matcher": getattr(job, "colmap_matcher", "sequential"),
                "max_image_size": getattr(job, "colmap_max_image_size", 1600),
                "max_num_features": getattr(job, "colmap_max_num_features", 4096),
            }
        )
        plan = build_colmap_plan(manifest, job.output_dir, colmap_cfg)
        emit_pipeline_progress(
            progress_cb,
            phase="align",
            stage="colmap.start",
            percent=PROGRESS_EXTRACT_END,
            phase_percent=0,
            message="启动 COLMAP 自动处理",
        )

        def colmap_progress(value):
            overall = _scale_progress(value, 35.0, 90.0, PROGRESS_EXTRACT_END, PROGRESS_ALIGN_END - 8.0)
            emit_pipeline_progress(
                progress_cb,
                phase="align",
                stage="colmap.reconstruction",
                percent=overall,
                phase_percent=_phase_percent_from_overall("align", overall),
                message="COLMAP 正在提取、匹配并重建稀疏点云",
            )

        run_colmap_plan(plan, progress_cb=colmap_progress, log_cb=log_cb)

        log_cb("应用向上轴转换")
        source_sparse = find_sparse_model_path(plan.sparse_dir)
        apply_up_axis_rotation(source_sparse, job.up_axis)
        emit_pipeline_progress(
            progress_cb,
            phase="align",
            stage="colmap.up_axis",
            percent=PROGRESS_ALIGN_END,
            message=f"已应用向上轴设置 {job.up_axis}",
        )

        log_cb("导出 COLMAP 输出")
        emit_pipeline_progress(
            progress_cb,
            phase="export",
            stage="colmap.publish",
            percent=PROGRESS_ALIGN_END,
            phase_percent=0,
            message="正在发布 COLMAP 输出",
        )
        publish_colmap_output(plan, job.output_dir)

        write_run_summary(job)
        emit_pipeline_progress(
            progress_cb,
            phase="export",
            stage="export.complete",
            percent=100,
            phase_percent=100,
            message="COLMAP 数据已导出",
        )
        log_cb("完成")
    else:
        log_cb("开始 Metashape 自动处理")
        script = Path(__file__).parent / "scripts" / "metashape_pipeline.py"
        metashape_runner = _resolve_metashape_runner(job.metashape_exe)
        if _norm_path(metashape_runner) != _norm_path(job.metashape_exe):
            log_cb("检测到 Metashape Portable 启动器，改用内部 metashape.exe 以避免恢复弹窗")
        _ensure_metashape_python_deps(metashape_runner, log_cb)
        cmd = [
            metashape_runner,
            "-r",
            str(script),
            "--manifest",
            str(manifest_path),
            "--export-dir",
            str(job.output_dir),
            "--keypoint-limit",
            str(job.metashape_keypoint_limit),
            "--tiepoint-limit",
            str(job.metashape_tiepoint_limit),
            "--up-axis",
            job.up_axis,
        ]
        emit_pipeline_progress(
            progress_cb,
            phase="align",
            stage="metashape.start",
            percent=PROGRESS_EXTRACT_END,
            phase_percent=0,
            message="启动 Metashape 自动对齐",
        )
        _clear_metashape_crash_state(job.metashape_exe)
        _clear_metashape_crash_state(metashape_runner)
        global _active_proc, _active_job
        _active_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=popen_creationflags(),
        )
        proc = _active_proc
        _active_job = guard_process(proc)
        emit_pipeline_progress(
            progress_cb,
            phase="align",
            stage="metashape.launch",
            percent=PROGRESS_EXTRACT_END + 2.0,
            message="Metashape 已启动，正在载入素材",
        )
        export_progress_state = {"overall": PROGRESS_ALIGN_END, "phase": 0.0}

        def emit_metashape_export_progress(stage, overall, phase_percent, message):
            export_progress_state["overall"] = max(export_progress_state["overall"], float(overall))
            export_progress_state["phase"] = max(export_progress_state["phase"], float(phase_percent))
            emit_pipeline_progress(
                progress_cb,
                phase="export",
                stage=stage,
                percent=export_progress_state["overall"],
                phase_percent=export_progress_state["phase"],
                message=message,
            )

        try:
            for line in proc.stdout:
                line = line.rstrip()
                if line.startswith("PROGRESS:"):
                    try:
                        value = int(line.split(":", 1)[1].strip())
                        if value >= 96:
                            overall = _scale_progress(value, 96.0, 100.0, PROGRESS_ALIGN_END, PROGRESS_EXPORT_END)
                            export_phase_percent = 0 if value <= 96 else 8 if value == 97 else _phase_percent_from_overall("export", overall)
                            emit_metashape_export_progress(
                                "metashape.export",
                                overall,
                                export_phase_percent,
                                "Metashape 正在导出 COLMAP/Cubemap",
                            )
                        else:
                            overall = _scale_progress(value, 35.0, 95.0, PROGRESS_EXTRACT_END, PROGRESS_ALIGN_END)
                            emit_pipeline_progress(
                                progress_cb,
                                phase="align",
                                stage="metashape.align",
                                percent=overall,
                                phase_percent=_phase_percent_from_overall("align", overall),
                                message="Metashape 正在匹配特征并对齐相机",
                            )
                    except Exception:
                        pass
                else:
                    match = re.search(r"处理中 \[(\d+)/(\d+)\]", line)
                    if match:
                        cur, total = int(match.group(1)), int(match.group(2))
                        safe_total = max(total, 1)
                        export_start = PROGRESS_ALIGN_END + (PROGRESS_EXPORT_END - PROGRESS_ALIGN_END) * 0.1
                        overall = _scale_progress(cur, 0, safe_total, export_start, PROGRESS_EXPORT_END - 1.5)
                        emit_metashape_export_progress(
                            "metashape.export_images",
                            overall,
                            _scale_progress(cur, 0, safe_total, 10, 95),
                            f"正在导出图像 {cur}/{total}",
                        )
                    if line:
                        log_cb(line)
            rc = proc.wait()
        finally:
            _active_proc = None
            _active_job = None
        if rc != 0:
            raise RuntimeError(f"Metashape 处理失败，返回码 {rc}")
        write_run_summary(job)
        emit_pipeline_progress(
            progress_cb,
            phase="export",
            stage="export.complete",
            percent=100,
            phase_percent=100,
            message="Metashape 对齐结果已导出",
        )
        log_cb("完成")


def run_metashape_pipeline(job: JobConfig, progress_cb, preview_cb, log_cb):
    multi_job = MultiTrackJobConfig(
        panorama_videos=[job.input_video],
        standard_photo_tracks=[],
        aerial_photo_tracks=[],
        output_dir=job.output_dir,
        seconds_per_frame=job.seconds_per_frame,
        max_frames=job.max_frames,
        metashape_exe=job.metashape_exe,
        overwrite_generated=job.overwrite_generated,
    )
    run_multi_track_pipeline(multi_job, progress_cb, preview_cb, log_cb)


class App:
    def __init__(self, root):
        load_gui_dependencies()
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry("1100x760")

        self.msg_queue = queue.Queue()
        self.left_preview = None
        self.right_preview = None
        self.material_tracks = []

        self.output_var = tk.StringVar()
        self.spf_var = tk.StringVar(value="1.0")
        self.frames_var = tk.StringVar(value="")
        self.metashape_var = tk.StringVar(value=locate_metashape())
        self.status_var = tk.StringVar(value="待机")
        self.track_count_var = tk.StringVar(value="0 tracks")
        self.advanced_visible = tk.BooleanVar(value=False)
        self.running = False

        self._build_ui()
        self.root.after(100, self._poll_queue)

    def _build_ui(self):
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(1, weight=1)

        header = ttk.Frame(self.root, padding=(16, 12, 16, 8))
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text="xPano 多相机轨重建", font=("Segoe UI", 15, "bold")).grid(row=0, column=0, sticky="w")
        ttk.Label(header, textvariable=self.track_count_var).grid(row=0, column=1, sticky="e")

        body = ttk.Frame(self.root, padding=(16, 0, 16, 12))
        body.grid(row=1, column=0, sticky="nsew")
        body.columnconfigure(0, weight=3)
        body.columnconfigure(1, weight=2)
        body.rowconfigure(1, weight=1)

        tracks_box = ttk.LabelFrame(body, text="素材轨")
        tracks_box.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 10))
        tracks_box.columnconfigure(0, weight=1)
        self.tracks_tree = ttk.Treeview(
            tracks_box,
            columns=("type", "label", "paths"),
            show="headings",
            height=5,
            selectmode="extended",
        )
        self.tracks_tree.heading("type", text="类型")
        self.tracks_tree.heading("label", text="名称")
        self.tracks_tree.heading("paths", text="路径")
        self.tracks_tree.column("type", width=140, stretch=False)
        self.tracks_tree.column("label", width=160, stretch=False)
        self.tracks_tree.column("paths", width=640, stretch=True)
        self.tracks_tree.grid(row=0, column=0, sticky="ew", padx=10, pady=(10, 6))
        track_buttons = ttk.Frame(tracks_box)
        track_buttons.grid(row=1, column=0, sticky="ew", padx=10, pady=(0, 10))
        ttk.Button(track_buttons, text="＋ 全景视频", command=self.add_panorama_track).pack(side="left")
        ttk.Button(track_buttons, text="＋ 普通照片", command=self.add_standard_photo_track).pack(side="left", padx=(8, 0))
        ttk.Button(track_buttons, text="＋ 航拍照片", command=self.add_aerial_photo_track).pack(side="left", padx=(8, 0))
        ttk.Button(track_buttons, text="✕ 删除选中", command=self.remove_selected_track).pack(side="right")

        preview_box = ttk.LabelFrame(body, text="图像预览")
        preview_box.grid(row=1, column=0, sticky="nsew", padx=(0, 10))
        preview_box.columnconfigure(0, weight=1)
        preview_box.rowconfigure(0, weight=1)
        preview_box.rowconfigure(1, weight=1)
        self.left_label = ttk.Label(preview_box, text="左鱼眼预览", anchor="center")
        self.left_label.grid(row=0, column=0, sticky="nsew", padx=10, pady=(10, 5))
        self.right_label = ttk.Label(preview_box, text="右鱼眼预览", anchor="center")
        self.right_label.grid(row=1, column=0, sticky="nsew", padx=10, pady=(5, 10))

        controls = ttk.Frame(body)
        controls.grid(row=1, column=1, sticky="nsew")
        controls.columnconfigure(0, weight=1)
        controls.rowconfigure(4, weight=1)

        output_box = ttk.LabelFrame(controls, text="输出")
        output_box.grid(row=0, column=0, sticky="ew")
        output_box.columnconfigure(0, weight=1)
        ttk.Entry(output_box, textvariable=self.output_var).grid(row=0, column=0, sticky="ew", padx=(10, 6), pady=10)
        ttk.Button(output_box, text="… 选择", command=self.pick_output).grid(row=0, column=1, padx=(0, 10), pady=10)

        self.advanced_button = ttk.Button(controls, text="▸ 高级参数", command=self.toggle_advanced)
        self.advanced_button.grid(row=1, column=0, sticky="ew", pady=(10, 0))
        self.advanced_frame = ttk.LabelFrame(controls, text="高级参数")
        self.advanced_frame.columnconfigure(1, weight=1)
        ttk.Label(self.advanced_frame, text="Metashape").grid(row=0, column=0, sticky="w", padx=10, pady=(10, 4))
        ttk.Entry(self.advanced_frame, textvariable=self.metashape_var).grid(row=0, column=1, sticky="ew", padx=6, pady=(10, 4))
        ttk.Button(self.advanced_frame, text="… 定位", command=self.pick_metashape).grid(row=0, column=2, padx=(0, 10), pady=(10, 4))
        ttk.Label(self.advanced_frame, text="秒/帧").grid(row=1, column=0, sticky="w", padx=10, pady=4)
        ttk.Entry(self.advanced_frame, textvariable=self.spf_var, width=12).grid(row=1, column=1, sticky="w", padx=6, pady=4)
        ttk.Label(self.advanced_frame, text="帧数上限").grid(row=2, column=0, sticky="w", padx=10, pady=(4, 10))
        frame_limit = ttk.Frame(self.advanced_frame)
        frame_limit.grid(row=2, column=1, sticky="w", padx=6, pady=(4, 10))
        ttk.Entry(frame_limit, textvariable=self.frames_var, width=12).pack(side="left")
        ttk.Label(frame_limit, text="留空=全部").pack(side="left", padx=(6, 0))

        progress_box = ttk.LabelFrame(controls, text="进度")
        progress_box.grid(row=3, column=0, sticky="ew", pady=(10, 0))
        progress_box.columnconfigure(1, weight=1)
        ttk.Label(progress_box, textvariable=self.status_var).grid(row=0, column=0, columnspan=2, sticky="w", padx=10, pady=(10, 6))
        self.pb = ttk.Progressbar(progress_box, orient="horizontal", mode="determinate", maximum=100)
        self.pb.grid(row=1, column=0, columnspan=2, sticky="ew", padx=10, pady=(0, 8))
        self.stage_bars = {}
        for row, (key, label) in enumerate([("extract", "抽帧"), ("align", "对齐"), ("export", "导出")], start=2):
            ttk.Label(progress_box, text=label).grid(row=row, column=0, sticky="w", padx=10, pady=3)
            bar = ttk.Progressbar(progress_box, orient="horizontal", mode="determinate", maximum=100)
            bar.grid(row=row, column=1, sticky="ew", padx=(0, 10), pady=3)
            self.stage_bars[key] = bar

        action_bar = ttk.Frame(controls)
        action_bar.grid(row=5, column=0, sticky="ew", pady=(10, 0))
        self.start_button = ttk.Button(action_bar, text="▶ 开始处理", command=self.start)
        self.start_button.pack(side="right")
        ttk.Button(action_bar, text="↗ 打开输出", command=self.open_output).pack(side="right", padx=(0, 8))
        self._sync_start_button_state()

        log_box = ttk.LabelFrame(controls, text="运行日志")
        log_box.grid(row=4, column=0, sticky="nsew", pady=(10, 0))
        log_box.rowconfigure(0, weight=1)
        log_box.columnconfigure(0, weight=1)
        self.log = tk.Text(log_box, height=12, wrap="word")
        self.log.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)

    def _add_material_track(self, track_type, label, paths):
        paths = [Path(path) for path in paths]
        if not paths:
            return
        self.material_tracks.append(MaterialTrack(track_type=track_type, label=label, paths=paths))
        self._refresh_tracks_tree()

    def _refresh_tracks_tree(self):
        for item in self.tracks_tree.get_children():
            self.tracks_tree.delete(item)
        for index, track in enumerate(self.material_tracks):
            display_paths = "; ".join(str(path) for path in track.paths)
            self.tracks_tree.insert("", "end", iid=str(index), values=(track.track_type, track.label, display_paths))
        self.track_count_var.set(f"{len(self.material_tracks)} tracks")
        self._sync_start_button_state()

    def _sync_start_button_state(self):
        if not hasattr(self, "start_button"):
            return
        if self.running or not self.material_tracks:
            self.start_button.configure(state="disabled")
        else:
            self.start_button.configure(state="normal")

    def toggle_advanced(self):
        if self.advanced_visible.get():
            self.advanced_frame.grid_remove()
            self.advanced_button.configure(text="▸ 高级参数")
            self.advanced_visible.set(False)
        else:
            self.advanced_frame.grid(row=2, column=0, sticky="ew", pady=(6, 0))
            self.advanced_button.configure(text="▾ 高级参数")
            self.advanced_visible.set(True)

    def add_panorama_track(self):
        paths = filedialog.askopenfilenames(filetypes=[("Panorama video", "*.osv *.insv *.mp4"), ("All", "*.*")])
        for path in paths:
            video = Path(path)
            self._add_material_track("panorama_video", video.stem, [video])

    def add_standard_photo_track(self):
        path = filedialog.askdirectory(title="Select standard photo folder")
        if path:
            folder = Path(path)
            self._add_material_track("standard_photos", folder.name or "standard_photos", [folder])

    def add_aerial_photo_track(self):
        path = filedialog.askdirectory(title="Select aerial photo folder")
        if path:
            folder = Path(path)
            self._add_material_track("aerial_photos", folder.name or "aerial_photos", [folder])

    def remove_selected_track(self):
        selected = sorted((int(item) for item in self.tracks_tree.selection()), reverse=True)
        for index in selected:
            if 0 <= index < len(self.material_tracks):
                del self.material_tracks[index]
        self._refresh_tracks_tree()

    def pick_output(self):
        p = filedialog.askdirectory()
        if p:
            self.output_var.set(p)

    def pick_metashape(self):
        p = filedialog.askopenfilename(filetypes=[("Metashape", "metashape.exe"), ("Executable", "*.exe")])
        if p:
            self.metashape_var.set(p)

    def open_output(self):
        if not self.output_var.get():
            messagebox.showinfo("输出文件夹", "请先选择输出文件夹")
            return
        output = Path(self.output_var.get())
        output.mkdir(parents=True, exist_ok=True)
        os.startfile(str(output))

    def start(self):
        if self.running:
            return
        if not self.material_tracks or not self.output_var.get():
            messagebox.showerror("缺少路径", "请先添加素材轨并选择输出文件夹")
            return
        try:
            spf = float(self.spf_var.get())
            if spf <= 0:
                raise ValueError
        except Exception:
            messagebox.showerror("参数错误", "请检查秒/帧输入，必须是大于 0 的数字")
            return
        try:
            max_text = self.frames_var.get().strip()
            max_frames = int(max_text) if max_text else 0
            if max_frames < 0:
                raise ValueError
        except Exception:
            messagebox.showerror("参数错误", "帧数上限必须留空，或填写大于等于 0 的整数")
            return

        output_dir = Path(self.output_var.get())
        metashape_exe = self.metashape_var.get().strip() or "metashape.exe"
        for track in self.material_tracks:
            for path in track.paths:
                if not Path(path).exists():
                    messagebox.showerror("输入不存在", str(path))
                    return
        if metashape_exe.lower() == "metashape.exe" and not shutil.which("metashape.exe"):
            messagebox.showerror("Metashape 不可用", "没有在 PATH 中找到 metashape.exe，请点击“定位”选择 Metashape。")
            return
        if metashape_exe.lower() != "metashape.exe" and not Path(metashape_exe).exists():
            messagebox.showerror("Metashape 不存在", metashape_exe)
            return
        if not shutil.which("ffmpeg"):
            messagebox.showerror("ffmpeg 不可用", "没有在 PATH 中找到 ffmpeg，请先安装 ffmpeg 并加入 PATH。")
            return
        stale = [path for path in generated_output_paths(output_dir) if path.exists()]
        if stale:
            names = "\n".join(str(path) for path in stale)
            if not messagebox.askyesno("覆盖旧输出", f"将清理以下旧输出后重新生成：\n{names}\n\n继续吗？"):
                return

        job = material_tracks_to_job_config(
            tracks=self.material_tracks,
            output_dir=output_dir,
            seconds_per_frame=spf,
            max_frames=max_frames,
            metashape_exe=metashape_exe,
        )

        self.running = True
        self.start_button.configure(state="disabled")
        self.pb["value"] = 0
        for bar in getattr(self, "stage_bars", {}).values():
            bar["value"] = 0
        self.status_var.set("运行中")
        threading.Thread(target=self._run_job, args=(job,), daemon=True).start()

    def _run_job(self, job):
        try:
            run_multi_track_pipeline(job, self._set_progress, self._show_preview, self._log)
            self.msg_queue.put(("done", "完成"))
        except Exception as exc:
            self.msg_queue.put(("error", str(exc)))

    def _set_progress(self, value):
        self.msg_queue.put(("progress", value))

    def _update_stage_progress(self, value):
        if not hasattr(self, "stage_bars"):
            return
        stages = {
            "extract": int(_phase_percent_from_overall("extract", value)),
            "align": int(_phase_percent_from_overall("align", value)),
            "export": int(_phase_percent_from_overall("export", value)),
        }
        for key, stage_value in stages.items():
            self.stage_bars[key]["value"] = stage_value

    def _show_preview(self, left_path, right_path):
        self.msg_queue.put(("preview", left_path, right_path))

    def _log(self, text):
        self.msg_queue.put(("log", text))

    def _poll_queue(self):
        try:
            while True:
                item = self.msg_queue.get_nowait()
                kind = item[0]
                if kind == "progress":
                    self.pb["value"] = item[1]
                    self._update_stage_progress(item[1])
                    self.status_var.set(f"进度 {item[1]}%")
                elif kind == "log":
                    self.log.insert("end", item[1] + "\n")
                    self.log.see("end")
                elif kind == "preview":
                    self._update_preview(item[1], item[2])
                elif kind == "done":
                    self.running = False
                    self._sync_start_button_state()
                    self.status_var.set(item[1])
                    self.pb["value"] = 100
                    messagebox.showinfo("完成", "处理完成")
                elif kind == "error":
                    self.running = False
                    self._sync_start_button_state()
                    self.status_var.set("失败")
                    messagebox.showerror("错误", item[1])
        except queue.Empty:
            pass
        self.root.after(100, self._poll_queue)

    def _update_preview(self, left_path, right_path):
        def load(path, target):
            img = Image.open(path).convert("RGB")
            img.thumbnail(target)
            return ImageTk.PhotoImage(img)

        self.left_preview = load(left_path, (460, 260))
        self.right_preview = load(right_path, (460, 260))
        self.left_label.configure(image=self.left_preview, text="")
        self.right_label.configure(image=self.right_preview, text="")


def main():
    load_gui_dependencies()
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log_path = Path(__file__).with_name("xpano_gui_error.log")
        log_path.write_text(traceback.format_exc(), encoding="utf-8")
        try:
            load_gui_dependencies()
            root = tk.Tk()
            root.withdraw()
            messagebox.showerror("xPano 启动失败", f"错误已写入:\n{log_path}")
            root.destroy()
        except Exception:
            pass
        raise
