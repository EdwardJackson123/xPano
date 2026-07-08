use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::AppHandle;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Lazy-initialised paths seeded once in `init()`.
// ---------------------------------------------------------------------------

static RESOURCE_BASE: OnceLock<PathBuf> = OnceLock::new();

/// Call once during startup from `tauri::Builder::setup()`.
pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().resource_dir() {
        RESOURCE_BASE.set(dir).ok();
    }
}

fn resource_base() -> Option<&'static Path> {
    RESOURCE_BASE.get().map(|p| p.as_path())
}

// ---------------------------------------------------------------------------
// Tool resolution: bundled > env var > PATH > hardcoded fallback
// ---------------------------------------------------------------------------

pub fn locate_tool(env_var: &str, name: &str, subdir: &str) -> String {
    let exe_name = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{}.exe", name)
    } else {
        name.to_string()
    };

    // 1. Bundled in resources (if init() was called and binary was bundled)
    if let Some(base) = resource_base() {
        for bundled in [
            base.join("binaries").join(subdir).join(&exe_name),
            base.join("_up_")
                .join("binaries")
                .join(subdir)
                .join(&exe_name),
            base.join("_up_")
                .join("_up_")
                .join("binaries")
                .join(subdir)
                .join(&exe_name),
        ] {
            if bundled.exists() {
                return bundled.to_string_lossy().into_owned();
            }
        }
    }

    // 2. Explicit env var.
    if let Ok(val) = std::env::var(env_var) {
        if Path::new(&val).exists() {
            return val;
        }
    }

    // 3. Search PATH.
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(if cfg!(windows) { ';' } else { ':' }) {
            if dir.is_empty() {
                continue;
            }
            let candidate = Path::new(dir).join(&exe_name);
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }

    // 4. Windows hardcoded fallback paths.
    #[cfg(windows)]
    {
        for dir in [
            r"D:\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin",
            r"D:\ffmpeg\bin",
            r"C:\ffmpeg\bin",
        ] {
            let candidate = Path::new(dir).join(&exe_name);
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }

    exe_name
}

pub fn locate_ffmpeg() -> String {
    locate_tool("XPANO_FFMPEG", "ffmpeg", "ffmpeg")
}

pub fn locate_ffprobe() -> String {
    locate_tool("XPANO_FFPROBE", "ffprobe", "ffmpeg")
}

// ---------------------------------------------------------------------------
// Script path resolution: use current_exe() instead of current_dir().
// ---------------------------------------------------------------------------

pub fn resolve_script_path(script: &str) -> PathBuf {
    if Path::new(script).is_absolute() {
        return PathBuf::from(script);
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let mut candidates = Vec::new();
    if let Some(base) = resource_base() {
        candidates.push(base.join(script));
        candidates.push(base.join("_up_").join(script));
        candidates.push(base.join("_up_").join("_up_").join(script));
    }
    candidates.extend([
        exe_dir.join(script),                       // same dir as exe
        exe_dir.join("..").join(script),            // exe parent (src-tauri in dev)
        exe_dir.join("..").join("..").join(script), // exe grandparent
        std::env::current_dir()
            .unwrap_or_default()
            .join("..")
            .join(script),
        std::env::current_dir().unwrap_or_default().join(script),
    ]);

    candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(script))
}

pub fn resolve_app_root() -> PathBuf {
    let marker = resolve_script_path("scripts/run_xpano_tracks_job.py");
    marker
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Python resolution
// ---------------------------------------------------------------------------

pub fn locate_densify_python(root: &Path) -> PathBuf {
    let candidates = [
        root.join(".venv-densify")
            .join("Scripts")
            .join("python.exe"),
        root.join(".venv-densify").join("bin").join("python.exe"),
        root.join(".venv-densify").join("bin").join("python"),
    ];
    candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| {
            root.join(".venv-densify")
                .join("Scripts")
                .join("python.exe")
        })
}

/// Resolve the best Python to use. Priority:
/// 1. Explicit non-empty path from caller.
/// 2. Bundled embedded Python.
/// 3. System `python` on PATH.
pub fn resolve_python(explicit: &str) -> String {
    let trimmed = explicit.trim();
    if !trimmed.is_empty() && Path::new(trimmed).exists() {
        return trimmed.to_string();
    }

    // Bundled embedded Python
    if let Some(base) = resource_base() {
        for bundled in [
            base.join("binaries").join("python").join("python.exe"),
            base.join("_up_")
                .join("binaries")
                .join("python")
                .join("python.exe"),
            base.join("_up_")
                .join("_up_")
                .join("binaries")
                .join("python")
                .join("python.exe"),
        ] {
            if bundled.exists() {
                return bundled.to_string_lossy().into_owned();
            }
        }
    }

    "python".to_string()
}
