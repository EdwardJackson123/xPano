#!/usr/bin/env python3
"""Generate 3DGS training masks for an existing xPano output.

This is intentionally independent from the alignment pipeline.  It reads
``<output>/images`` and atomically publishes matching 8-bit PNG masks to
``<output>/masks``.  White pixels are valid training pixels; black pixels are
excluded dynamic objects.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import threading
import time
import traceback
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Iterable, Iterator, Sequence


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}
DEFAULT_SCORE_THRESHOLD = 0.7
DEFAULT_MASK_THRESHOLD = 0.5
DEFAULT_CLOSE_KERNEL = 5
DEFAULT_EXPAND_PIXELS = 15
DEFAULT_EXPAND_PERCENT = 1.0
DEFAULT_EDGE_FUSE_PIXELS = 25

COCO_CATEGORIES = {
    1: "person", 2: "bicycle", 3: "car", 4: "motorcycle", 5: "airplane",
    6: "bus", 7: "train", 8: "truck", 9: "boat", 10: "traffic light",
    11: "fire hydrant", 13: "stop sign", 14: "parking meter", 15: "bench",
    16: "bird", 17: "cat", 18: "dog", 19: "horse", 20: "sheep", 21: "cow",
    22: "elephant", 23: "bear", 24: "zebra", 25: "giraffe", 27: "backpack",
    28: "umbrella", 31: "handbag", 32: "tie", 33: "suitcase", 34: "frisbee",
    35: "skis", 36: "snowboard", 37: "sports ball", 38: "kite",
    39: "baseball bat", 40: "baseball glove", 41: "skateboard", 42: "surfboard",
    43: "tennis racket", 44: "bottle", 46: "wine glass", 47: "cup", 48: "fork",
    49: "knife", 50: "spoon", 51: "bowl", 52: "banana", 53: "apple",
    54: "sandwich", 55: "orange", 56: "broccoli", 57: "carrot", 58: "hot dog",
    59: "pizza", 60: "donut", 61: "cake", 62: "chair", 63: "couch",
    64: "potted plant", 65: "bed", 67: "dining table", 70: "toilet", 72: "tv",
    73: "laptop", 74: "mouse", 75: "remote", 76: "keyboard", 77: "cell phone",
    78: "microwave", 79: "oven", 80: "toaster", 81: "sink", 82: "refrigerator",
    84: "book", 85: "clock", 86: "vase", 87: "scissors", 88: "teddy bear",
    89: "hair drier", 90: "toothbrush",
}
NAME_TO_LABELS = {name: {label} for label, name in COCO_CATEGORIES.items()}
NAME_TO_LABELS["animal"] = {16, 17, 18}
ALIASES = {"motorbike": "motorcycle", "cellphone": "cell phone", "hairdryer": "hair drier"}


class DiagnosticTee:
    """Write diagnostics to disk first, then best-effort mirror to the UI pipe."""

    def __init__(self, stream, log_file, lock: threading.Lock):
        self.stream = stream
        self.log_file = log_file
        self.lock = lock

    def write(self, text: str) -> int:
        with self.lock:
            self.log_file.write(text)
            self.log_file.flush()
        try:
            self.stream.write(text)
            self.stream.flush()
        except (BrokenPipeError, OSError):
            pass
        return len(text)

    def flush(self) -> None:
        with self.lock:
            self.log_file.flush()
        try:
            self.stream.flush()
        except (BrokenPipeError, OSError):
            pass


def install_diagnostic_log(output: str, argv: Sequence[str]) -> Path:
    output_dir = Path(output).expanduser().resolve()
    log_dir = output_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "xpano_mask.log"
    log_file = log_path.open("w", encoding="utf-8", buffering=1)
    log_file.write("xPano mask process\n")
    log_file.write(f"Python: {sys.executable}\n")
    log_file.write(f"Script: {Path(__file__).resolve()}\n")
    log_file.write(f"Output: {output_dir}\n")
    log_file.write("Arguments: " + " ".join(argv) + "\n---\n")
    log_file.flush()
    lock = threading.Lock()
    sys.stdout = DiagnosticTee(sys.stdout, log_file, lock)
    sys.stderr = DiagnosticTee(sys.stderr, log_file, lock)
    return log_path


def emit(status: str, percent: float, message: str, **extra: object) -> None:
    payload = {"status": status, "percent": round(float(percent), 2), "message": message, **extra}
    print("MASK_EVENT:" + json.dumps(payload, ensure_ascii=False), flush=True)


def normalize_targets(raw: str) -> list[str]:
    values: list[str] = []
    invalid: list[str] = []
    for item in raw.replace(";", ",").split(","):
        name = " ".join(item.strip().lower().replace("_", " ").replace("-", " ").split())
        name = ALIASES.get(name, name)
        if not name:
            continue
        if name not in NAME_TO_LABELS:
            invalid.append(name)
        elif name not in values:
            values.append(name)
    if invalid:
        raise ValueError("不支持的遮罩类别: " + ", ".join(invalid))
    if not values:
        raise ValueError("至少需要一个遮罩类别")
    return values


def collect_images(images_dir: Path) -> list[Path]:
    return sorted(
        (path for path in images_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS),
        key=lambda path: path.name.lower(),
    )


def load_runtime():
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
        import torch  # type: ignore
        import torchvision  # type: ignore
    except ImportError as exc:
        name = getattr(exc, "name", None) or str(exc)
        raise RuntimeError(
            f"缺少遮罩依赖 {name}。请在 xPano 使用的 Python 中安装 torch、torchvision、opencv-python、Pillow 和 numpy。"
        ) from exc
    return cv2, np, Image, torch, torchvision


def build_model(torchvision, device, score_threshold: float):
    detection = torchvision.models.detection
    try:
        weights = detection.MaskRCNN_ResNet50_FPN_Weights.DEFAULT
        model = detection.maskrcnn_resnet50_fpn(weights=weights)
    except (AttributeError, TypeError):
        model = detection.maskrcnn_resnet50_fpn(pretrained=True)
    model.roi_heads.score_thresh = score_threshold
    model.roi_heads.detections_per_img = 100
    try:
        model.transform.min_size = (640,)
        model.transform.max_size = 1024
    except Exception:
        pass
    return model.to(device).eval()


def combine_prediction(prediction, labels: set[int], score_threshold: float, mask_threshold: float, np):
    pred_labels = prediction["labels"].detach().cpu().numpy()
    scores = prediction["scores"].detach().cpu().numpy()
    masks = prediction["masks"].detach().cpu().numpy()
    selected = np.isin(pred_labels, list(labels)) & (scores >= score_threshold)
    if not np.any(selected):
        height, width = masks.shape[-2:] if masks.ndim == 4 else (0, 0)
        return np.zeros((height, width), dtype=np.uint8)
    return np.any(masks[selected, 0] > mask_threshold, axis=0).astype(np.uint8) * 255


def expand_mask(mask, mode: str, pixels: int, percent: float, cv2, np):
    height, width = mask.shape
    amount = pixels if mode == "pixels" else int(round(max(height, width) * percent / 100.0))
    if amount <= 0 or not np.any(mask):
        return mask
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (amount * 2 + 1, amount * 2 + 1))
    return cv2.dilate(mask, kernel, iterations=1)


def fuse_to_edges(mask, distance: int, cv2, np):
    if distance <= 0 or not np.any(mask):
        return mask
    height, width = mask.shape
    distance = min(distance, height, width)
    result = mask.copy()
    spread = max(1, round(distance * 0.35))
    horizontal = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (spread * 2 + 1, 1))
    vertical = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (1, spread * 2 + 1))
    top = cv2.dilate(mask[:distance].copy(), horizontal, iterations=1)
    bottom = cv2.dilate(mask[-distance:].copy(), horizontal, iterations=1)
    left = cv2.dilate(mask[:, :distance].copy(), vertical, iterations=1)
    right = cv2.dilate(mask[:, -distance:].copy(), vertical, iterations=1)
    for x in np.where(np.any(top > 0, axis=0))[0]:
        ys = np.where(top[:, x] > 0)[0]
        result[: int(ys.min()) + 1, x] = 255
    for x in np.where(np.any(bottom > 0, axis=0))[0]:
        ys = np.where(bottom[:, x] > 0)[0]
        result[height - distance + int(ys.max()):, x] = 255
    for y in np.where(np.any(left > 0, axis=1))[0]:
        xs = np.where(left[y] > 0)[0]
        result[y, : int(xs.min()) + 1] = 255
    for y in np.where(np.any(right > 0, axis=1))[0]:
        xs = np.where(right[y] > 0)[0]
        result[y, width - distance + int(xs.max()):] = 255
    return result


def estimate_shadow(image_rgb, target_mask, cv2, np):
    if not np.any(target_mask):
        return np.zeros_like(target_mask)
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    illumination = cv2.GaussianBlur(gray, (0, 0), 21)
    candidate = ((gray / (illumination + 1e-6) < 0.82) & ((illumination - gray) >= 12)).astype(np.uint8) * 255
    saturation = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)[:, :, 1]
    candidate[saturation > 115] = 0
    radius = max(25, min(128, int(math.sqrt(max(1, np.count_nonzero(target_mask))) * 0.2)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius | 1, radius | 1))
    near = cv2.dilate(target_mask, kernel, iterations=1)
    candidate = cv2.bitwise_and(candidate, near)
    candidate[target_mask > 0] = 0
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    contours, _ = cv2.findContours(candidate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    clean = np.zeros_like(candidate)
    for contour in contours:
        if cv2.contourArea(contour) >= 160:
            cv2.drawContours(clean, [contour], -1, 255, -1)
    return clean


def load_image(path: Path, Image, np):
    with Image.open(path) as source:
        rgb = source.convert("RGB")
        return path, np.asarray(rgb).copy()


def prefetch_images(paths: Sequence[Path], workers: int, Image, np) -> Iterator[tuple[Path, object]]:
    if workers <= 1:
        for path in paths:
            yield load_image(path, Image, np)
        return
    iterator = iter(paths)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = set()
        for _ in range(min(len(paths), workers * 2)):
            try:
                pending.add(pool.submit(load_image, next(iterator), Image, np))
            except StopIteration:
                break
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                yield future.result()
                try:
                    pending.add(pool.submit(load_image, next(iterator), Image, np))
                except StopIteration:
                    pass


def prepare_staging(output_dir: Path) -> Path:
    staging = output_dir / f".masks-xpano-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    return staging


def publish_masks(staging: Path, masks_dir: Path) -> None:
    backup = masks_dir.with_name(".masks-xpano-backup")
    if backup.exists():
        shutil.rmtree(backup)
    if masks_dir.exists():
        masks_dir.replace(backup)
    try:
        staging.replace(masks_dir)
    except Exception:
        if backup.exists() and not masks_dir.exists():
            backup.replace(masks_dir)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def run(args: argparse.Namespace) -> None:
    started = time.monotonic()
    output_dir = Path(args.output).expanduser().resolve()
    images_dir = output_dir / "images"
    masks_dir = output_dir / "masks"
    if not images_dir.is_dir():
        raise RuntimeError(f"最终训练图片目录不存在: {images_dir}")
    images = collect_images(images_dir)
    if not images:
        raise RuntimeError(f"最终训练图片目录中没有受支持的图片: {images_dir}")
    stems = [path.stem.casefold() for path in images]
    if len(stems) != len(set(stems)):
        raise RuntimeError("最终 images 中存在同名但扩展名不同的图片，无法生成一一对应的 PNG 遮罩")
    targets = normalize_targets(args.targets)
    cv2, np, Image, torch, torchvision = load_runtime()
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("已选择 CUDA，但当前 PyTorch 无法使用 CUDA")
    device_name = "cuda" if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available()) else "cpu"
    device = torch.device(device_name)
    labels = set().union(*(NAME_TO_LABELS[name] for name in targets))
    emit("loading", 0, f"正在加载 Mask R-CNN（{device_name.upper()}）", total=len(images), device=device_name)
    model = build_model(torchvision, device, args.score_threshold)
    staging = prepare_staging(output_dir)
    try:
        emit("running", 0, f"开始处理 {len(images)} 张最终训练图片", total=len(images), device=device_name)
        for index, (path, image_rgb) in enumerate(prefetch_images(images, args.workers, Image, np), 1):
            tensor = torch.from_numpy(np.ascontiguousarray(image_rgb)).permute(2, 0, 1).float().div_(255.0).to(device)
            with torch.inference_mode():
                prediction = model([tensor])[0]
            target_mask = combine_prediction(prediction, labels, args.score_threshold, args.mask_threshold, np)
            if target_mask.shape != image_rgb.shape[:2]:
                target_mask = cv2.resize(target_mask, (image_rgb.shape[1], image_rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
            if args.close_kernel > 1:
                kernel_size = args.close_kernel | 1
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
                target_mask = cv2.morphologyEx(target_mask, cv2.MORPH_CLOSE, kernel)
            if args.include_shadow:
                target_mask = np.maximum(target_mask, estimate_shadow(image_rgb, target_mask, cv2, np))
            target_mask = expand_mask(target_mask, args.expand_mode, args.expand_pixels, args.expand_percent, cv2, np)
            target_mask = fuse_to_edges(target_mask, args.edge_fuse_pixels, cv2, np)
            training_mask = 255 - np.where(target_mask > 0, 255, 0).astype(np.uint8)
            Image.fromarray(training_mask, mode="L").save(staging / f"{path.stem}.png")
            percent = index * 100.0 / len(images)
            emit("running", percent, f"已处理 {index}/{len(images)}：{path.name}", current=index, total=len(images), device=device_name)
        produced = list(staging.glob("*.png"))
        if len(produced) != len(images):
            raise RuntimeError(f"遮罩完整性校验失败：预期 {len(images)}，实际 {len(produced)}")
        publish_masks(staging, masks_dir)
        emit("complete", 100, f"遮罩处理完成：{masks_dir}", current=len(images), total=len(images), outputPath=str(masks_dir), elapsed=int(time.monotonic() - started), device=device_name)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate xPano 3DGS training masks")
    parser.add_argument("--output", required=True, help="Existing xPano output directory containing images/")
    parser.add_argument("--targets", default="person", help="Comma-separated COCO target names")
    parser.add_argument("--include-shadow", action="store_true")
    parser.add_argument("--expand-mode", choices=("pixels", "percent"), default="pixels")
    parser.add_argument("--expand-pixels", type=int, default=DEFAULT_EXPAND_PIXELS)
    parser.add_argument("--expand-percent", type=float, default=DEFAULT_EXPAND_PERCENT)
    parser.add_argument("--edge-fuse-pixels", type=int, default=DEFAULT_EDGE_FUSE_PIXELS)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--workers", type=int, default=max(1, min(8, os.cpu_count() or 1)))
    parser.add_argument("--score-threshold", type=float, default=DEFAULT_SCORE_THRESHOLD)
    parser.add_argument("--mask-threshold", type=float, default=DEFAULT_MASK_THRESHOLD)
    parser.add_argument("--close-kernel", type=int, default=DEFAULT_CLOSE_KERNEL)
    return parser


def main() -> int:
    parser = make_parser()
    args = parser.parse_args()
    if args.expand_pixels < 0 or args.expand_percent < 0 or args.edge_fuse_pixels < 0:
        parser.error("遮罩扩张和边缘融合参数不能为负数")
    if args.workers < 1:
        parser.error("workers 必须大于等于 1")
    if not 0 <= args.score_threshold <= 1 or not 0 <= args.mask_threshold <= 1:
        parser.error("阈值必须在 0 到 1 之间")
    try:
        log_path = install_diagnostic_log(args.output, sys.argv[1:])
        print(f"LOG_FILE:{log_path}", flush=True)
    except Exception as exc:
        print(f"ERROR: 无法创建遮罩日志: {exc}", file=sys.stderr, flush=True)
        return 1
    try:
        run(args)
        return 0
    except Exception as exc:
        emit("error", 0, str(exc))
        traceback.print_exc(file=sys.stderr)
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
