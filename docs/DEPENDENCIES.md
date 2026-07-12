# xPano Dependencies

## Python Environments

xPano uses separate Python execution contexts for different purposes. This separation is intentional: the main pipeline runs inside Metashape's embedded Python, while ML features require a regular Python installation. Mask generation may use the configured system Python or an existing compatible virtual environment, but its dependencies must be installed into the exact interpreter selected in the UI.

### 1. Metashape Embedded Python (main pipeline)

**Used by:** `scripts/metashape_pipeline.py` — all SfM alignment and COLMAP export.

**Location:** `<Metashape>/python/python.exe` (bundled with Agisoft Metashape).

**Dependencies (`metashape_requirements.txt`):**
- `numpy==1.26.4`
- `opencv-python-headless==4.10.0.84`

**Install:** `scripts/install_deps.ps1` detects the Metashape installation and uses its embedded Python.

**Notes:**
- Metashape's Python is locked to a specific numpy version.
- Never `pip install` into this environment except through `install_deps.ps1`.
- This is the only Python that can `import Metashape`.

### 2. `.venv-densify` (densification + point cloud cleaning)

**Used by:**
- `scripts/run_lfs_densify_viewer.py` — LichtFeld densification (RoMaV2)
- `scripts/pointcloud_clean.py` — sparse point cloud outlier removal

**Location:** `<project>/.venv-densify/`

**Created by:** `scripts/install_lfs_densify.ps1` using the system/Minconda Python's `venv` module.

**Key packages (auto-installed by the install script):**

| Package | Purpose |
|---------|---------|
| `torch` 2.8 + CUDA 12.8 | Deep learning backend for RoMaV2 |
| `torchvision` | Image transforms |
| `open3d` 0.19 | Point cloud filters (SOR, radius, DBSCAN) |
| `pycolmap` 4.0.4 | COLMAP Python bindings |
| `numpy`, `scipy` | Numerical computation |
| `einops`, `rich`, `tqdm` | Utilities |

**Disk usage:** ~4-6 GB (mostly PyTorch + CUDA runtime)

### 3. Mask generation environment

**Used by:** `scripts/xpano_masks.py` (Mask R-CNN object segmentation).

Install into the same Python executable configured in the xPano UI:

```powershell
# NVIDIA GPU / CUDA (recommended)
.\INSTALL_MASKS_CUDA.bat

# CPU-only fallback
.\INSTALL_MASKS_CPU.bat

# Explicit Python selected in xPano
.\INSTALL_MASKS_CUDA.bat -Python "C:\path\to\python.exe"
```

The complete dependency declaration is in `mask_requirements.txt`. The installer
selects the matching official PyTorch package index and downloads the torchvision
Mask R-CNN ResNet-50 FPN COCO weights so that the first mask job does not need to
download them. Use `-SkipModelDownload` only when preparing an offline package
that supplies the PyTorch model cache separately.

**Important:** installing into a different Python from the one selected in xPano
will not make the dependencies available to mask generation.

### 4. System/Minconda Python

**Used by:** The Tauri GUI (`app.py`) for launching pipelines.

**Location:** `D:\software\Miniconda\app\python.exe` (or system PATH).

**Dependencies (`requirements.txt`):**
- `Pillow` — GUI thumbnail generation
- `piexif` — EXIF handling
- `tqdm` — progress bars

This Python only needs lightweight packages for the main pipeline. If it is also
selected for mask generation, install `mask_requirements.txt` through one of the
mask installers above. It does **not** need open3d or pycolmap.

### Why Separate Python Environments?

| | Metashape Python | `.venv-densify` Python |
|---|---|---|
| Can `import Metashape` | ✅ | ❌ |
| Has PyTorch + CUDA | ❌ | ✅ |
| Has open3d | ❌ | ✅ |
| Can `pip install` freely | ❌ (locked by vendor) | ✅ |
| Purpose | SfM pipeline | ML + geometry processing |

Merging them into one is not possible: Metashape's Python cannot load PyTorch, and a regular Python cannot import Metashape.

---

## Rust Backend

**Location:** `xpano-ui/src-tauri/`

**Key dependencies (`Cargo.toml`):**

| Crate | Purpose |
|-------|---------|
| `tauri` 2.x | Desktop application framework |
| `serde` / `serde_json` | JSON serialization for IPC |
| `tauri-plugin-dialog` | File open/save dialogs |
| `opener` | Open files/folders in OS |

**Build artifacts:** `target/` directory can reach ~11 GB. Run `cargo clean` periodically.

---

## Frontend

**Location:** `xpano-ui/`

**Key dependencies (`package.json`):**

| Package | Purpose |
|---------|---------|
| `react` 19 + `react-dom` | UI framework |
| `three` + `@react-three/fiber` + `@react-three/drei` | 3D point cloud rendering |
| `@tauri-apps/api` | IPC bridge to Rust backend |
| `gsap` | Animation library |
| `tailwindcss` | Utility CSS framework |
| `lucide-react` | Icon set |

**Disk usage:** `node_modules/` ~327 MB

---

## External Tools

These are standalone binaries downloaded by install scripts:

| Tool | Location | Install Script |
|------|----------|----------------|
| COLMAP 4.0.4 | `tools/colmap/` | `scripts/install_colmap.ps1` |
| LichtFeld Plugin | `tools/lichtfeld-densification-plugin/` | `scripts/install_lfs_densify.ps1` |
| ffmpeg | System PATH | Manual install |

---

## Disk Usage Summary

| Component | Approximate Size | Notes |
|-----------|-----------------|-------|
| `.venv-densify/` | 4-6 GB | PyTorch + CUDA + open3d |
| Rust `target/` | up to 11 GB | `cargo clean` to reclaim |
| `node_modules/` | 327 MB | `pnpm store prune` to reclaim |
| `tools/` | ~1.1 GB | COLMAP binaries + densify plugin |
| Git repo (clean) | ~47 MB | After `git gc` |

**Total with build artifacts:** ~13-16 GB
**Total for distribution:** ~6-7 GB (venv + tools, no build artifacts)

To reduce disk usage:
```powershell
# Remove Rust build artifacts (rebuild on next `pnpm tauri dev`)
cargo clean

# Remove unused pnpm packages
pnpm store prune

# The .venv-densify and tools/ are required for full functionality
```

---

## Quick Setup

```powershell
# 1. Install external tools
.\scripts\install_colmap.ps1        # COLMAP
.\scripts\install_lfs_densify.ps1   # .venv-densify + LichtFeld plugin

# 2. Install Python deps for Metashape
.\scripts\install_deps.ps1

# 3. Install frontend deps
cd xpano-ui
pnpm install

# 4. Run
pnpm tauri dev
```
