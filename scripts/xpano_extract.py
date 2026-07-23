import json
import math
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import piexif

from scripts.process_guard import cleanup_process_tree, guard_process, popen_creationflags
from scripts.runtime_paths import locate_ffmpeg, locate_ffprobe


SUPPORTED_EXTENSIONS = {".insv", ".osv", ".mp4"}


def _probe_media(input_path: Path):
    result = subprocess.run(
        [
            locate_ffprobe(), "-v", "error", "-show_streams", "-show_format",
            "-of", "json", str(input_path),
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return json.loads(result.stdout or "{}")


def _video_streams(input_path: Path):
    streams = []
    for stream in _probe_media(input_path).get("streams", []):
        if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic"):
            streams.append(stream)
    return streams


def _stream_time(stream, key, default=None):
    try:
        value = float(stream.get(key))
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def _validate_split_sync(left: Path, right: Path, fps, log_cb=None):
    left_streams = _video_streams(left)
    right_streams = _video_streams(right)
    if len(left_streams) != 1 or len(right_streams) != 1:
        raise RuntimeError(
            "Paired INSV files must each contain exactly one video stream; "
            f"got {len(left_streams)} and {len(right_streams)}"
        )
    ls, rs = left_streams[0], right_streams[0]
    start_l = _stream_time(ls, "start_time", 0.0)
    start_r = _stream_time(rs, "start_time", 0.0)
    duration_l = _stream_time(ls, "duration")
    duration_r = _stream_time(rs, "duration")
    tolerance = max(0.05, 0.5 / max(float(fps), 1e-6))
    if abs(start_l - start_r) > tolerance:
        raise RuntimeError(
            f"Dual-fisheye streams are not synchronized: start PTS differs by {abs(start_l - start_r):.3f}s"
        )
    if duration_l is not None and duration_r is not None and abs(duration_l - duration_r) > tolerance:
        raise RuntimeError(
            f"Dual-fisheye streams have different durations: {duration_l:.3f}s vs {duration_r:.3f}s"
        )
    if log_cb:
        log_cb(
            "dual-fisheye sync verified: "
            f"start delta={abs(start_l - start_r):.4f}s, tolerance={tolerance:.4f}s"
        )
    return int(ls["index"]), int(rs["index"])


def _dual_video_stream_indices(input_path: Path, fps=None):
    streams = _video_streams(input_path)
    if len(streams) != 2:
        raise RuntimeError(
            f"Panorama OSV/MP4 must contain exactly two video streams; found {len(streams)}. "
            "A normal video plus audio is not a dual-fisheye source."
        )
    if fps:
        start_a = _stream_time(streams[0], "start_time", 0.0)
        start_b = _stream_time(streams[1], "start_time", 0.0)
        duration_a = _stream_time(streams[0], "duration")
        duration_b = _stream_time(streams[1], "duration")
        tolerance = max(0.05, 0.5 / max(float(fps), 1e-6))
        if abs(start_a - start_b) > tolerance:
            raise RuntimeError(
                f"Dual-fisheye streams are not synchronized: start PTS differs by {abs(start_a - start_b):.3f}s"
            )
        if duration_a is not None and duration_b is not None and abs(duration_a - duration_b) > tolerance:
            raise RuntimeError(
                f"Dual-fisheye streams have different durations: {duration_a:.3f}s vs {duration_b:.3f}s"
            )
    return int(streams[0]["index"]), int(streams[1]["index"])


def _apply_exif(img_path: Path, model: str, make: str):
    try:
        exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
        exif_dict["0th"][piexif.ImageIFD.Make] = make.encode()
        exif_dict["0th"][piexif.ImageIFD.Model] = model.encode()
        piexif.insert(piexif.dump(exif_dict), str(img_path))
    except Exception:
        pass


def _frame_preview(left_path: Path, right_path: Path, preview_cb):
    if preview_cb is None:
        return
    preview_cb(str(left_path), str(right_path))


def _append_frame_limit(cmd, max_frames):
    if max_frames and max_frames > 0:
        cmd.extend(["-frames:v", str(max_frames)])


def _probe_duration_seconds(input_path: Path, log_cb=None):
    try:
        result = subprocess.run(
            [
                locate_ffprobe(),
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(input_path),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        duration = float(result.stdout.strip())
        return duration if duration > 0 else None
    except Exception as exc:
        if log_cb:
            log_cb(f"ffprobe duration unavailable for {input_path.name}: {exc}")
        return None


def _expected_frame_count(input_path: Path, fps, max_frames, log_cb=None):
    if max_frames and max_frames > 0:
        return max_frames
    duration = _probe_duration_seconds(input_path, log_cb=log_cb)
    if not duration:
        return None
    return max(1, int(duration * fps + 0.999999))


def _count_generated_pairs(out_root: Path, base_name: str):
    if not out_root or not base_name:
        return 0
    left_count = len(list(out_root.glob(f"{base_name}_L_*.jpg")))
    right_count = len(list(out_root.glob(f"{base_name}_R_*.jpg")))
    return min(left_count, right_count)


def _run_ffmpeg(cmd, input_path: Path, fps, max_frames, progress_cb=None, log_cb=None, out_root=None, base_name=None):
    expected_frames = _expected_frame_count(input_path, fps, max_frames, log_cb=log_cb)
    if log_cb:
        if expected_frames:
            log_cb(f"ffmpeg extracting {input_path.name}, expected frames: {expected_frames}")
        else:
            log_cb(f"ffmpeg extracting {input_path.name}, expected frames unknown")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=popen_creationflags(),
    )
    job = guard_process(proc)
    reader = None
    try:
        output_lines = []
        last_frame = 0
        last_logged_frame = 0
        last_log_time = 0.0
        reader_done = threading.Event()
        frame_lock = threading.Lock()
        log_step = max(1, (expected_frames or 100) // 20)

        def emit_progress(current, final=False):
            if not progress_cb:
                return
            total = expected_frames or 100
            if final:
                current = total
            elif expected_frames:
                current = max(0, min(int(current), total))
            else:
                current = max(0, min(int(current), total - 1))
            progress_cb(current, total)

        def set_last_frame(value):
            nonlocal last_frame
            with frame_lock:
                last_frame = max(last_frame, int(value))
                return last_frame

        def get_last_frame():
            with frame_lock:
                return last_frame

        def read_output():
            try:
                for raw_line in proc.stdout:
                    line = raw_line.strip()
                    if not line:
                        continue
                    output_lines.append(line)
                    key, sep, value = line.partition("=")
                    if sep and key == "frame":
                        try:
                            emit_progress(set_last_frame(int(value.strip())))
                        except ValueError:
                            pass
                    elif sep and key == "out_time_ms":
                        try:
                            seconds = int(value.strip()) / 1000000.0
                            emit_progress(set_last_frame(seconds * fps))
                        except ValueError:
                            pass
                    elif sep and key == "progress":
                        if value == "end":
                            emit_progress(expected_frames or get_last_frame(), final=True)
                    elif log_cb and not sep:
                        log_cb(line)
            finally:
                reader_done.set()

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        out_root = Path(out_root) if out_root else None
        while proc.poll() is None:
            generated = _count_generated_pairs(out_root, base_name)
            if generated:
                emit_progress(set_last_frame(generated))

            now = time.monotonic()
            current_frame = get_last_frame()
            if log_cb and expected_frames and (
                current_frame - last_logged_frame >= log_step or now - last_log_time >= 5
            ):
                last_logged_frame = current_frame
                last_log_time = now
                log_cb(f"extract progress {min(current_frame, expected_frames)}/{expected_frames}")
            time.sleep(0.25)

        rc = proc.wait()
        reader_done.wait(timeout=2)
        reader.join(timeout=2)
        generated = _count_generated_pairs(out_root, base_name)
        if generated:
            emit_progress(set_last_frame(generated))
        if rc != 0:
            tail = "\n".join(output_lines[-20:])
            raise subprocess.CalledProcessError(rc, cmd, output=tail)
    finally:
        cleanup_process_tree(proc, job)
        if reader is not None:
            reader.join(timeout=2)


def _extract_one(args):
    task, fps, out_root, max_frames, start_time, end_time, preview_cb, progress_cb, log_cb, model_prefix = args
    left = task["left_file"]
    right = task["right_file"]
    base_name = task["clean_name"]
    # Trim window: -ss seeks the input (fast keyframe seek before decoding),
    # -t bounds the output duration. We use -t (duration = end - start) instead of
    # -to because, with input seeking, -to is measured against an inconsistent
    # timestamp base and silently over-extracts (verified: -ss 30 -to 60 yields
    # 60 frames instead of 30). -t is unambiguous.
    has_start = start_time and float(start_time) > 0
    duration = float(end_time) - float(start_time) if (end_time and float(end_time) > float(start_time)) else 0.0
    has_duration = duration > 0
    seek_args = (["-ss", str(start_time)] if has_start else [])
    t_args = (["-t", str(duration)] if has_duration else [])
    if task["type"] == "insta_split":
        left_stream, right_stream = _validate_split_sync(left, right, fps, log_cb=log_cb)
        cmd = [
            locate_ffmpeg(), "-hide_banner", "-y", "-nostdin", "-progress", "pipe:1", "-nostats",
            *seek_args, "-i", str(left),
            *seek_args, "-i", str(right),
            "-map", f"0:{left_stream}", *t_args, "-vf", f"fps={fps}",
        ]
        _append_frame_limit(cmd, max_frames)
        cmd.extend([
            "-q:v", "2",
            str(out_root / f"{base_name}_L_%05d.jpg"),
            "-map", f"1:{right_stream}", *t_args, "-vf", f"fps={fps}",
        ])
        _append_frame_limit(cmd, max_frames)
        cmd.extend([
            "-q:v", "2",
            str(out_root / f"{base_name}_R_%05d.jpg"),
        ])
    else:
        left_stream, right_stream = _dual_video_stream_indices(left, fps=fps)
        cmd = [
            locate_ffmpeg(), "-hide_banner", "-y", "-nostdin", "-progress", "pipe:1", "-nostats",
            *seek_args, "-i", str(left),
            "-map", f"0:{left_stream}", *t_args, "-vf", f"fps={fps}",
        ]
        _append_frame_limit(cmd, max_frames)
        cmd.extend([
            "-q:v", "2",
            str(out_root / f"{base_name}_L_%05d.jpg"),
            "-map", f"0:{right_stream}", *t_args, "-vf", f"fps={fps}",
        ])
        _append_frame_limit(cmd, max_frames)
        cmd.extend([
            "-q:v", "2",
            str(out_root / f"{base_name}_R_%05d.jpg"),
        ])
    _run_ffmpeg(
        cmd,
        left,
        fps,
        max_frames,
        progress_cb=progress_cb,
        log_cb=log_cb,
        out_root=out_root,
        base_name=base_name,
    )

    left_files = sorted(out_root.glob(f"{base_name}_L_*.jpg"))
    right_files = sorted(out_root.glob(f"{base_name}_R_*.jpg"))
    if len(left_files) != len(right_files):
        raise RuntimeError(
            "Dual-fisheye extraction produced unequal frame counts; refusing to silently pair "
            f"{len(left_files)} left frames with {len(right_files)} right frames"
        )
    count = len(left_files)
    if count == 0:
        raise RuntimeError("Dual-fisheye extraction produced no synchronized frame pairs")
    if max_frames and max_frames > 0:
        count = min(count, max_frames)
    extracted = []
    for idx in range(count):
        frame_idx = idx + 1
        frame_dir = out_root / f"{base_name}_frame_{frame_idx:05d}"
        frame_dir.mkdir(exist_ok=True)
        ldst = frame_dir / f"{base_name}_frame_{frame_idx:05d}_left.jpg"
        rdst = frame_dir / f"{base_name}_frame_{frame_idx:05d}_right.jpg"
        shutil.move(str(left_files[idx]), str(ldst))
        shutil.move(str(right_files[idx]), str(rdst))
        make = "Insta360" if left.suffix.lower() == ".insv" else "DJI"
        model_root = model_prefix or make.lower()
        _apply_exif(ldst, f"{model_root}_left", make)
        _apply_exif(rdst, f"{model_root}_right", make)
        extracted.append((ldst, rdst))
        _frame_preview(ldst, rdst, preview_cb)
        if progress_cb:
            progress_cb(frame_idx, count)
    return extracted


def extract_frames(input_path, out_root, fps, max_frames=0, start_time=0.0, end_time=0.0, preview_cb=None, progress_cb=None, log_cb=None, model_prefix=None):
    input_path = Path(input_path)
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    files = [input_path]
    pair_map = {}
    if input_path.suffix.lower() == ".insv":
        m = re.search(r"(VID_\d+_\d+)_(00|10)_(\d+)", input_path.name)
        if m:
            prefix, side, suffix = m.groups()
            other = "10" if side == "00" else "00"
            partner = input_path.parent / f"{prefix}_{other}_{suffix}.insv"
            if partner.exists():
                # Insta360 naming is canonical: _00 is lens/stream L and _10 is R.
                # Never let the file the user happened to select flip the rig.
                left_path = input_path.parent / f"{prefix}_00_{suffix}.insv"
                right_path = input_path.parent / f"{prefix}_10_{suffix}.insv"
                files = [left_path, right_path]
                pair_map[left_path] = right_path
                input_path = left_path
    task = {
        "clean_name": input_path.stem,
        "left_file": input_path,
        "right_file": pair_map.get(input_path, input_path),
        "type": "insta_split" if input_path.suffix.lower() == ".insv" and pair_map.get(input_path) else "dji_dual",
    }
    if progress_cb:
        progress_cb(0, max_frames if max_frames and max_frames > 0 else 1)
    extracted = _extract_one((task, fps, out_root, max_frames, start_time, end_time, preview_cb, progress_cb, log_cb, model_prefix))
    if progress_cb:
        progress_cb(1, 1)
    return extracted
