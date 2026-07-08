# xPano Dependencies

## Python Environments

xPano uses two Python environments for different purposes. This separation is intentional: the main pipeline runs inside Metashape's embedded Python (which has no `pip`), while the densification and point-cloud cleaning features need PyTorch and Open3D which live in a dedicated virtual environment.

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

### 3. System/Minconda Python

**Used by:** The Tauri GUI (`app.py`) for launching pipelines.

**Location:** `D:\software\Miniconda\app\python.exe` (or system PATH).

**Dependencies (`requirements.txt`):**
- `Pillow` — GUI thumbnail generation
- `piexif` — EXIF handling
- `tqdm` — progress bars

This Python only needs lightweight packages. It does **not** need open3d, torch, or pycolmap.

### Why Two Pythons?

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
