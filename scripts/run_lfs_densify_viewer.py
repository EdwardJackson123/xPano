import argparse
import json
import os
import shutil
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure:
        _reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.colmap_backend import (
    read_colmap_cameras,
    read_colmap_images,
    read_colmap_points3d,
    write_colmap_cameras,
    write_colmap_images,
    write_colmap_points3d,
)
from scripts.colmap_dense_merge import merge_dense_ply_into_colmap_points
from scripts.lichtfeld_densify import (
    LichtfeldDensifyConfig,
    locate_densify_plugin,
    locate_densify_python,
    run_densify_command,
)


def safe_print(text):
    try:
        print(localize_log_text(text), flush=True)
        return True
    except (BrokenPipeError, OSError):
        return False


def localize_log_text(text):
    text = str(text).replace("\r", "\n")
    stripped = text.strip()
    if stripped == "Initializing RoMa v2 model...":
        return "正在初始化 RoMa v2 模型..."
    if stripped.startswith('Downloading: "') and '" to ' in stripped:
        return stripped.replace("Downloading:", "正在下载模型文件：").replace('" to ', '" -> ')
    if stripped.startswith("Done!"):
        return stripped.replace("Done!", "完成！", 1)
    if stripped.startswith("Dense reconstruction finished:"):
        return stripped.replace("Dense reconstruction finished:", "致密化重建完成：", 1)
    if stripped.startswith("ERROR:"):
        return stripped.replace("ERROR:", "错误：", 1)
    return text


def parse_args():
    parser = argparse.ArgumentParser(description="为已有 xPano 输出运行 LichtFeld 致密化。")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--python-exe", default="")
    parser.add_argument("--plugin-dir", default="")
    parser.add_argument("--roma", default="fast", choices=["turbo", "fast", "base", "high", "precise"])
    parser.add_argument("--num-refs", type=float, default=0.8)
    parser.add_argument("--nns-per-ref", type=int, default=1)
    parser.add_argument("--matches-per-ref", type=int, default=10000)
    parser.add_argument("--certainty-thresh", type=float, default=0.2)
    parser.add_argument("--max-points", type=int, default=200000)
    parser.add_argument(
        "--image-filter",
        default="front_plus_hd",
        choices=["all", "cube_all", "front", "hd", "front_plus_hd"],
    )
    parser.add_argument("--roi-start", type=float, default=0.0)
    parser.add_argument("--roi-end", type=float, default=1.0)
    parser.add_argument("--keep-ply", action="store_true")
    return parser.parse_args()


def require_xpano_output(output_dir):
    output_dir = Path(output_dir).resolve()
    sparse_dir = output_dir / "sparse" / "0"
    images_dir = output_dir / "images"
    for path in [
        sparse_dir / "cameras.bin",
        sparse_dir / "images.bin",
        sparse_dir / "points3D.bin",
        images_dir,
    ]:
        if not path.exists():
            raise RuntimeError(f"缺少必要的 xPano 输出路径：{path}")
    return output_dir, sparse_dir


def image_kind(name):
    lower = name.lower()
    if lower.startswith("cube_front_"):
        return "front"
    if lower.startswith("cube_"):
        return "cube"
    if lower.startswith("frame_"):
        return "hd"
    return "other"


def image_matches_filter(name, image_filter):
    kind = image_kind(name)
    if image_filter == "all":
        return True
    if image_filter == "cube_all":
        return kind in {"front", "cube"}
    if image_filter == "front":
        return kind == "front"
    if image_filter == "hd":
        return kind == "hd"
    if image_filter == "front_plus_hd":
        return kind in {"front", "hd"}
    return True


def apply_roi(images, roi_start, roi_end):
    start = min(max(float(roi_start), 0.0), 1.0)
    end = min(max(float(roi_end), 0.0), 1.0)
    if end < start:
        start, end = end, start
    if start <= 0.0 and end >= 1.0:
        return images
    if not images:
        return images

    grouped = {}
    for image in images:
        grouped.setdefault(image_kind(image["name"]), []).append(image)

    selected = []
    for group_images in grouped.values():
        ordered = sorted(group_images, key=lambda item: item["name"])
        count = len(ordered)
        lo = int(count * start)
        hi = max(lo + 1, int(round(count * end)))
        selected.extend(ordered[lo:min(hi, count)])
    return sorted(selected, key=lambda item: item["id"])


def link_or_copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def prepare_filtered_scene(output_dir, sparse_dir, image_filter, roi_start, roi_end):
    cameras = read_colmap_cameras(sparse_dir)
    images = read_colmap_images(sparse_dir)
    points = read_colmap_points3d(sparse_dir)

    selected_images = [image for image in images if image_matches_filter(image["name"], image_filter)]
    selected_images = apply_roi(selected_images, roi_start, roi_end)
    if len(selected_images) < 2:
        raise RuntimeError(f"选中的图片数量过少，无法进行致密化：{len(selected_images)}")

    selected_image_ids = {image["id"] for image in selected_images}
    selected_camera_ids = {image["camera_id"] for image in selected_images}
    selected_cameras = [camera for camera in cameras.values() if camera["id"] in selected_camera_ids]

    filtered_points = []
    for point in points:
        track = [(image_id, point2d_idx) for image_id, point2d_idx in point["track"] if image_id in selected_image_ids]
        if len(track) >= 2:
            item = dict(point)
            item["track"] = track
            filtered_points.append(item)
    retained_point_ids = {int(point["id"]) for point in filtered_points}
    cleaned_images = []
    for image in selected_images:
        item = dict(image)
        item["points2d"] = [
            (x, y, point3d_id if int(point3d_id) in retained_point_ids else -1)
            for x, y, point3d_id in image["points2d"]
        ]
        cleaned_images.append(item)
    selected_images = cleaned_images

    workspace = output_dir / "workspace" / "lfs_densify_scene"
    if workspace.exists():
        shutil.rmtree(workspace)
    scene_sparse = workspace / "sparse" / "0"
    scene_images = workspace / "images"
    scene_sparse.mkdir(parents=True, exist_ok=True)
    scene_images.mkdir(parents=True, exist_ok=True)

    write_colmap_cameras(scene_sparse / "cameras.bin", selected_cameras)
    write_colmap_images(scene_sparse / "images.bin", selected_images)
    write_colmap_points3d(scene_sparse / "points3D.bin", filtered_points)

    source_images = output_dir / "images"
    for image in selected_images:
        link_or_copy(source_images / image["name"], scene_images / image["name"])

    summary = {
        "scene_root": str(workspace),
        "selected_images": len(selected_images),
        "selected_cameras": len(selected_cameras),
        "selected_points": len(filtered_points),
        "image_filter": image_filter,
        "roi_start": roi_start,
        "roi_end": roi_end,
        "front_images": sum(1 for image in selected_images if image_kind(image["name"]) == "front"),
        "hd_images": sum(1 for image in selected_images if image_kind(image["name"]) == "hd"),
    }
    (output_dir / "workspace" / "lfs_densify_selection.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return workspace, summary


def main():
    args = parse_args()
    if args.max_points < 0:
        raise ValueError("--max-points 必须大于或等于 0")
    if args.num_refs <= 0:
        raise ValueError("--num-refs 必须大于 0")

    output_dir, sparse_dir = require_xpano_output(args.output_dir)
    scene_root, selection = prepare_filtered_scene(
        output_dir,
        sparse_dir,
        args.image_filter,
        args.roi_start,
        args.roi_end,
    )
    plugin_dir = Path(args.plugin_dir).resolve() if args.plugin_dir else locate_densify_plugin()
    python_exe = args.python_exe or locate_densify_python()
    scene_sparse = scene_root / "sparse" / "0"
    dense_ply = scene_sparse / "points3D_dense.ply"

    config = LichtfeldDensifyConfig(
        python_exe=python_exe,
        plugin_dir=plugin_dir,
        scene_root=scene_root,
        images_subdir="images",
        out_name=dense_ply.name,
        roma_setting=args.roma,
        num_refs=args.num_refs,
        nns_per_ref=args.nns_per_ref,
        matches_per_ref=args.matches_per_ref,
        certainty_thresh=args.certainty_thresh,
        max_points=args.max_points,
    )

    def progress(value):
        safe_print(f"PROGRESS:{value}")

    run_densify_command(config, progress_cb=progress, log_cb=safe_print)
    merge = merge_dense_ply_into_colmap_points(
        scene_sparse,
        dense_ply,
        output_points_path=sparse_dir / "points3D_dense.bin",
        replace_points_bin=False,
        target_sparse_model_dir=sparse_dir,
    )
    result = {
        **merge,
        "dense_ply_path": str(dense_ply),
        "backup_points_path": str(sparse_dir / "points3D_sparse_original.bin"),
        "roma": args.roma,
        "max_points": args.max_points,
        **selection,
    }
    (output_dir / "workspace").mkdir(parents=True, exist_ok=True)
    (output_dir / "workspace" / "lfs_densify_summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if dense_ply.exists() and not args.keep_ply:
        dense_ply.unlink()
        result["dense_ply_path"] = ""
    safe_print(f"致密化结果已生成：原始 {result['original_points']} 点，新增 {result['dense_points']} 点，总计 {result['merged_points']} 点")
    safe_print("DENSIFY_RESULT:" + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        safe_print(f"ERROR:{exc}")
        raise
