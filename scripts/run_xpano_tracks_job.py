import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import MaterialTrack, MultiTrackJobConfig, locate_metashape, material_tracks_to_job_config, run_multi_track_pipeline
from scripts.dependency_checks import (
    check_pipeline_dependencies,
    format_dependency_report,
    locate_colmap,
    locate_lichtfield,
    require_dependency_checks,
    resolve_executable,
)
from scripts.pipeline_backends import COLMAP_BACKEND, METASHAPE_BACKEND, SUPPORTED_BACKENDS, normalize_backend
from scripts.colmap_backend import COLMAP_DENSITY_PRESETS
from scripts.lichtfeld_densify import locate_densify_python
from scripts.xpano_tracks import load_manifest, validate_manifest


def parse_track_args(values):
    tracks = []
    for value in values or []:
        if len(value) < 2:
            raise ValueError("Photo tracks require LABEL followed by one or more paths")
        tracks.append((value[0], value[1:]))
    return tracks


def build_material_tracks(
    panorama_videos,
    standard_tracks,
    aerial_tracks,
    pano_starts=None,
    pano_ends=None,
    pano_seconds_per_frame=None,
    pano_max_frames=None,
    default_seconds_per_frame=1.0,
    default_max_frames=0,
):
    tracks = []
    pano_starts = pano_starts or []
    pano_ends = pano_ends or []
    pano_seconds_per_frame = pano_seconds_per_frame or []
    pano_max_frames = pano_max_frames or []
    for idx, path in enumerate(panorama_videos):
        video = Path(path).resolve()
        # Pair trim windows with pano entries by position; missing entries default to no trim.
        start = pano_starts[idx] if idx < len(pano_starts) else 0.0
        end = pano_ends[idx] if idx < len(pano_ends) else 0.0
        seconds_per_frame = pano_seconds_per_frame[idx] if idx < len(pano_seconds_per_frame) else default_seconds_per_frame
        max_frames = pano_max_frames[idx] if idx < len(pano_max_frames) else default_max_frames
        trim = (start, end) if (start or end) else None
        tracks.append(MaterialTrack(
            track_type="panorama_video",
            label=video.stem,
            paths=[video],
            trim=trim,
            seconds_per_frame=seconds_per_frame,
            max_frames=max_frames,
        ))
    for label, paths in standard_tracks:
        tracks.append(MaterialTrack(track_type="standard_photos", label=label, paths=[Path(path).resolve() for path in paths]))
    for label, paths in aerial_tracks:
        tracks.append(MaterialTrack(track_type="aerial_photos", label=label, paths=[Path(path).resolve() for path in paths]))
    return tracks


def validate_run_args(seconds_per_frame, max_frames):
    if seconds_per_frame <= 0:
        raise ValueError("--seconds-per-frame must be greater than 0")
    if max_frames < 0:
        raise ValueError("--max-frames must be greater than or equal to 0")


def validate_pano_extract_args(seconds_per_frame_values, max_frame_values):
    for value in seconds_per_frame_values or []:
        if value <= 0:
            raise ValueError("--pano-seconds-per-frame must be greater than 0")
    for value in max_frame_values or []:
        if value < 0:
            raise ValueError("--pano-max-frames must be greater than or equal to 0")


def configure_console_output():
    for stream in [sys.stdout, sys.stderr]:
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")


def main():
    configure_console_output()
    parser = argparse.ArgumentParser(description="Run xPano multi-material-track workflow")
    parser.add_argument("--output")
    parser.add_argument("--metashape", default=locate_metashape())
    parser.add_argument("--colmap", default=locate_colmap())
    parser.add_argument("--colmap-density-preset", default="stable", choices=COLMAP_DENSITY_PRESETS)
    parser.add_argument("--colmap-matcher", default="sequential", choices=["sequential", "exhaustive"])
    parser.add_argument("--colmap-use-gpu", action="store_true", help="Enable COLMAP CUDA/GPU feature extraction and matching.")
    parser.add_argument("--colmap-max-image-size", type=int, default=1600)
    parser.add_argument("--colmap-max-num-features", type=int, default=4096)
    parser.add_argument("--metashape-keypoint-limit", type=int, default=40000)
    parser.add_argument("--metashape-tiepoint-limit", type=int, default=0)
    parser.add_argument("--up-axis", default="+Y", choices=["+Y", "-Y", "+Z", "-Z", "+X", "-X"])
    parser.add_argument("--backend", default=METASHAPE_BACKEND, choices=sorted(SUPPORTED_BACKENDS))
    parser.add_argument("--check-env", action="store_true", help="Print dependency diagnostics and exit.")
    parser.add_argument("--strict", action="store_true", help="With --check-env, fail if required dependencies are missing.")
    parser.add_argument("--run-lichtfield", action="store_true")
    parser.add_argument("--lichtfield", default=locate_lichtfield())
    parser.add_argument("--lichtfield-point-count", type=int, default=0)
    parser.add_argument("--lichtfield-bilateral-grid", type=int, default=0)
    parser.add_argument("--run-lfs-densify", action="store_true")
    parser.add_argument("--lfs-densify-python", default=locate_densify_python())
    parser.add_argument("--lfs-densify-plugin")
    parser.add_argument("--lfs-densify-roma", default="fast", choices=["precise", "high", "base", "fast", "turbo"])
    parser.add_argument("--lfs-densify-num-refs", type=float, default=8.0)
    parser.add_argument("--lfs-densify-max-points", type=int, default=0)
    parser.add_argument("--seconds-per-frame", type=float, default=1.0)
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument("--skip-extract", action="store_true", help="Skip frame extraction; reuse existing manifest and frames.")
    parser.add_argument("--manifest")
    parser.add_argument("--pano", action="append", default=[], help="Panorama OSV/INSV/MP4 video. Repeat for multiple panorama tracks.")
    parser.add_argument("--pano-start", action="append", type=float, default=[], help="Panorama trim start (seconds), paired with --pano by position. Default 0.")
    parser.add_argument("--pano-end", action="append", type=float, default=[], help="Panorama trim end (seconds), paired with --pano by position. 0 = full length.")
    parser.add_argument("--pano-seconds-per-frame", action="append", type=float, default=[], help="Per-panorama extraction interval in seconds, paired with --pano by position.")
    parser.add_argument("--pano-max-frames", action="append", type=int, default=[], help="Per-panorama frame limit, paired with --pano by position. 0 = no limit.")
    parser.add_argument("--standard-track", action="append", nargs="+", default=[], metavar=("LABEL", "PATH"))
    parser.add_argument("--aerial-track", action="append", nargs="+", default=[], metavar=("LABEL", "PATH"))
    parser.add_argument("--keep-generated", action="store_true")
    args = parser.parse_args()

    backend = normalize_backend(args.backend)
    run_lichtfield = backend == COLMAP_BACKEND and args.run_lichtfield
    if args.check_env:
        checks = check_pipeline_dependencies(
            backend=backend,
            metashape_exe=args.metashape,
            colmap_exe=args.colmap,
            lichtfield_exe=args.lichtfield,
            run_lichtfield=run_lichtfield,
            run_lfs_densify=args.run_lfs_densify,
            lfs_densify_python=args.lfs_densify_python,
            lfs_densify_plugin=args.lfs_densify_plugin,
        )
        print(format_dependency_report(checks), flush=True)
        if args.strict:
            require_dependency_checks(checks)
        return
    if not args.output:
        raise ValueError("--output is required unless --check-env is used")
    output_dir = Path(args.output).resolve()
    if args.lichtfield_point_count < 0:
        raise ValueError("--lichtfield-point-count must be greater than or equal to 0")
    if args.lichtfield_bilateral_grid < 0:
        raise ValueError("--lichtfield-bilateral-grid must be greater than or equal to 0")
    if args.lfs_densify_max_points < 0:
        raise ValueError("--lfs-densify-max-points must be greater than or equal to 0")
    if args.lfs_densify_num_refs <= 0:
        raise ValueError("--lfs-densify-num-refs must be greater than 0")

    if args.manifest:
        manifest_path = Path(args.manifest).resolve()
        validate_manifest(load_manifest(manifest_path))
    else:
        validate_run_args(args.seconds_per_frame, args.max_frames)
        validate_pano_extract_args(args.pano_seconds_per_frame, args.pano_max_frames)
        manifest_path = None

    metashape_exe = args.metashape
    if backend == METASHAPE_BACKEND:
        metashape_exe = resolve_executable(args.metashape, "metashape.exe")
    colmap_exe = resolve_executable(args.colmap, "colmap") if backend == COLMAP_BACKEND else args.colmap
    lichtfield_exe = resolve_executable(args.lichtfield, "lichtfield-studio") if run_lichtfield else args.lichtfield
    lfs_densify_plugin = Path(args.lfs_densify_plugin).resolve() if args.lfs_densify_plugin else None

    if manifest_path:
        job = MultiTrackJobConfig(
            panorama_videos=[],
            standard_photo_tracks=[],
            aerial_photo_tracks=[],
            output_dir=output_dir,
            seconds_per_frame=args.seconds_per_frame,
            max_frames=args.max_frames,
            metashape_exe=metashape_exe,
            overwrite_generated=False,
            manifest_path=manifest_path,
            backend=backend,
            colmap_exe=colmap_exe,
            colmap_density_preset=args.colmap_density_preset,
            colmap_matcher=args.colmap_matcher,
            colmap_use_gpu=args.colmap_use_gpu,
            colmap_max_image_size=args.colmap_max_image_size,
            colmap_max_num_features=args.colmap_max_num_features,
            metashape_keypoint_limit=args.metashape_keypoint_limit,
            metashape_tiepoint_limit=args.metashape_tiepoint_limit,
            up_axis=args.up_axis,
            run_lichtfield=run_lichtfield,
            lichtfield_exe=lichtfield_exe,
            lichtfield_point_count=args.lichtfield_point_count,
            lichtfield_bilateral_grid=args.lichtfield_bilateral_grid,
            run_lfs_densify=args.run_lfs_densify,
            lfs_densify_python=args.lfs_densify_python,
            lfs_densify_plugin=lfs_densify_plugin,
            lfs_densify_roma=args.lfs_densify_roma,
            lfs_densify_num_refs=args.lfs_densify_num_refs,
            lfs_densify_max_points=args.lfs_densify_max_points,
            skip_extract=args.skip_extract,
        )
    else:
        tracks = build_material_tracks(
            args.pano,
            parse_track_args(args.standard_track),
            parse_track_args(args.aerial_track),
            pano_starts=args.pano_start,
            pano_ends=args.pano_end,
            pano_seconds_per_frame=args.pano_seconds_per_frame,
            pano_max_frames=args.pano_max_frames,
            default_seconds_per_frame=args.seconds_per_frame,
            default_max_frames=args.max_frames,
        )
        job = material_tracks_to_job_config(
            tracks=tracks,
            output_dir=output_dir,
            seconds_per_frame=args.seconds_per_frame,
            max_frames=args.max_frames,
            metashape_exe=metashape_exe,
            overwrite_generated=not args.keep_generated,
            backend=backend,
            colmap_exe=colmap_exe,
            colmap_density_preset=args.colmap_density_preset,
            colmap_matcher=args.colmap_matcher,
            colmap_use_gpu=args.colmap_use_gpu,
            colmap_max_image_size=args.colmap_max_image_size,
            colmap_max_num_features=args.colmap_max_num_features,
            metashape_keypoint_limit=args.metashape_keypoint_limit,
            metashape_tiepoint_limit=args.metashape_tiepoint_limit,
            up_axis=args.up_axis,
            run_lichtfield=run_lichtfield,
            lichtfield_exe=lichtfield_exe,
            lichtfield_point_count=args.lichtfield_point_count,
            lichtfield_bilateral_grid=args.lichtfield_bilateral_grid,
            run_lfs_densify=args.run_lfs_densify,
            lfs_densify_python=args.lfs_densify_python,
            lfs_densify_plugin=lfs_densify_plugin,
            lfs_densify_roma=args.lfs_densify_roma,
            lfs_densify_num_refs=args.lfs_densify_num_refs,
            lfs_densify_max_points=args.lfs_densify_max_points,
            skip_extract=args.skip_extract,
        )

    def progress(value):
        if isinstance(value, dict):
            print(f"PIPELINE_EVENT:{json.dumps(value, ensure_ascii=False)}", flush=True)
        else:
            print(f"PROGRESS:{value}", flush=True)

    progress.supports_structured = True

    def preview(left, right):
        print(f"PREVIEW:{left}|{right}", flush=True)

    def log(text):
        print(text, flush=True)

    run_multi_track_pipeline(job, progress, preview, log)
    print("xPano multi-track job complete", flush=True)


if __name__ == "__main__":
    main()
