import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.colmap_backend import apply_axis_flip, apply_colmap_ground_alignment, find_sparse_model_path


def resolve_sparse_model(output_dir):
    root = Path(output_dir).resolve()
    if all((root / name).exists() for name in ("cameras.bin", "images.bin", "points3D.bin")):
        return root
    sparse_root = root / "sparse"
    if sparse_root.exists():
        return find_sparse_model_path(sparse_root)
    return find_sparse_model_path(root)


def main():
    parser = argparse.ArgumentParser(description="Post-process a COLMAP sparse model axis orientation.")
    parser.add_argument("--output-dir", required=True, help="xPano output directory or direct COLMAP sparse model directory.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--flip-axis", choices=["x", "y", "z", "X", "Y", "Z"])
    action.add_argument("--align-ground", action="store_true", help="Estimate the ground plane and rotate it to the selected viewer up axis.")
    parser.add_argument("--up-axis", default="+Y", choices=["+X", "-X", "+Y", "-Y", "+Z", "-Z"])
    args = parser.parse_args()

    sparse_dir = resolve_sparse_model(args.output_dir)
    if args.flip_axis:
        axis = args.flip_axis.lower()
        apply_axis_flip(sparse_dir, axis)
        result = {
            "ok": True,
            "action": "flip_axis",
            "axis": axis,
            "sparse_dir": str(sparse_dir),
        }
    else:
        result = apply_colmap_ground_alignment(sparse_dir, up_axis=args.up_axis)
        result["action"] = "align_ground"
        result["sparse_dir"] = str(sparse_dir)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
