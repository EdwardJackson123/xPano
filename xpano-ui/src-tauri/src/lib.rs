mod pipeline;
mod process_job;
mod thumbgen;
mod tool_resolver;

use pipeline::PipelineState;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use thumbgen::ThumbgenState;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Camera pose returned to the frontend.
#[derive(Serialize, Clone)]
struct ColmapCamera {
    id: u32,
    /// [x, y, z] in COLMAP world coordinates
    position: [f32; 3],
    /// [qw, qx, qy, qz] quaternion
    rotation: [f32; 4],
    /// FOV in radians (computed from camera intrinsics), or a sensible default
    fov: f32,
    /// Aspect ratio (width / height), or a sensible default
    aspect: f32,
    /// Near plane
    near: f32,
    /// Far plane
    far: f32,
}

/// COLMAP point cloud data returned to the frontend.
#[derive(Serialize, Clone)]
struct ColmapPointCloud {
    /// Flat f32 array: [x0,y0,z0, x1,y1,z1, ...]
    points: Vec<f32>,
    /// Flat f32 array: [r0,g0,b0, r1,g1,b1, ...] normalized 0..1
    colors: Vec<f32>,
    num_points: usize,
    total_points: usize,
    sampled: bool,
    cameras: Vec<ColmapCamera>,
}

type CameraIntrinsics = (f32, f32, f32, f32);
type CameraIntrinsicsMap = std::collections::HashMap<u32, CameraIntrinsics>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DensifyEnvStatus {
    plugin_ok: bool,
    python_ok: bool,
    deps_ok: bool,
    runner_ok: bool,
    plugin_path: String,
    python_path: String,
    message: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DensifyRunResult {
    #[serde(alias = "original_points")]
    original_points: usize,
    #[serde(alias = "dense_points")]
    dense_points: usize,
    #[serde(alias = "merged_points")]
    merged_points: usize,
    #[serde(alias = "output_points_path")]
    output_points_path: String,
    #[serde(alias = "replaced_points_bin")]
    replaced_points_bin: bool,
    #[serde(alias = "dense_ply_path")]
    dense_ply_path: String,
    #[serde(alias = "backup_points_path")]
    backup_points_path: String,
    roma: String,
    #[serde(alias = "max_points")]
    max_points: usize,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct DensifyPersistedState {
    status: String,
    message: String,
    result: Option<DensifyRunResult>,
    log_path: String,
    updated_at: u64,
}

fn count_colmap_points_bin(path: &std::path::Path) -> Result<usize, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开点云文件: {}", e))?;
    let file_size = file
        .metadata()
        .map_err(|e| format!("读取点云文件信息失败: {}", e))?
        .len();
    let mut reader = BufReader::new(file);
    let mut num_bytes = [0u8; 8];
    reader
        .read_exact(&mut num_bytes)
        .map_err(|e| format!("读取点数失败: {}", e))?;
    let count = u64::from_le_bytes(num_bytes);
    let min_size = 8u64.saturating_add(count.saturating_mul(51));
    if file_size < min_size {
        return Err(format!(
            "点云文件可能未写完整: {} ({} bytes < expected at least {})",
            path.display(),
            file_size,
            min_size
        ));
    }
    Ok(count as usize)
}

fn find_bin(dir: &str, names: &[&str]) -> Option<std::path::PathBuf> {
    for name in names {
        let p = std::path::Path::new(dir).join(name);
        if p.exists() {
            return Some(p);
        }
    }
    // Also try sparse/ subdirectories
    let sparse_dirs = &["sparse/0", "sparse"];
    for sparse_dir in sparse_dirs {
        let base = std::path::Path::new(dir).join(sparse_dir);
        for name in names {
            let p = base.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

fn read_cameras_bin(path: &std::path::Path) -> Result<CameraIntrinsicsMap, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开 cameras.bin: {}", e))?;
    let mut reader = BufReader::new(file);
    let mut num_bytes = [0u8; 8];
    reader
        .read_exact(&mut num_bytes)
        .map_err(|e| format!("读取相机数失败: {}", e))?;
    let num_cameras = u64::from_le_bytes(num_bytes) as usize;
    let mut cameras = std::collections::HashMap::new();

    for _ in 0..num_cameras {
        let mut header = [0u8; 24]; // camera_id(u32) + model(u32) + width(u64) + height(u64)
        reader
            .read_exact(&mut header)
            .map_err(|e| format!("读取相机头失败: {}", e))?;
        let camera_id = u32::from_le_bytes(header[0..4].try_into().unwrap());
        let model = u32::from_le_bytes(header[4..8].try_into().unwrap());
        let width = u64::from_le_bytes(header[8..16].try_into().unwrap()) as f32;
        let height = u64::from_le_bytes(header[16..24].try_into().unwrap()) as f32;

        // Determine number of params based on model
        let num_params: usize = match model {
            0 => 3,   // SIMPLE_PINHOLE: f, cx, cy
            1 => 4,   // PINHOLE: fx, fy, cx, cy
            2 => 4,   // SIMPLE_RADIAL: f, cx, cy, k
            3 => 5,   // RADIAL: f, cx, cy, k1, k2
            4 => 8,   // OPENCV: fx, fy, cx, cy, k1, k2, p1, p2
            5 => 8,   // OPENCV_FISHEYE: fx, fy, cx, cy, k1, k2, k3, k4
            6 => 12,  // FULL_OPENCV: fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, k5, k6
            7 => 5,   // FOV: fx, fy, cx, cy, omega
            8 => 4,   // SIMPLE_RADIAL_FISHEYE: f, cx, cy, k
            9 => 5,   // RADIAL_FISHEYE: f, cx, cy, k1, k2
            10 => 12, // THIN_PRISM_FISHEYE: fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, sx1, sy1
            _ => 0,
        };
        let mut param_bytes = vec![0u8; num_params * 8];
        reader
            .read_exact(&mut param_bytes)
            .map_err(|e| format!("读取相机参数失败: {}", e))?;

        let aspect = if height > 0.0 { width / height } else { 1.55 };
        // Extract fx (or f) as the first parameter for most models
        let fx = if num_params >= 1 {
            f64::from_le_bytes(param_bytes[0..8].try_into().unwrap()) as f32
        } else {
            width
        };
        // FOV = 2 * atan(height / (2 * fy))
        // But for simplicity, use: fov = 2 * atan(height / (2 * fx))
        let fy = if model >= 4 && num_params >= 2 {
            f64::from_le_bytes(param_bytes[8..16].try_into().unwrap()) as f32
        } else {
            fx
        };
        let fov = if fy > 0.0 && height > 0.0 {
            2.0 * (height / (2.0 * fy)).atan()
        } else {
            std::f32::consts::PI / 3.0 // default ~60°
        };

        cameras.insert(camera_id, (fov, aspect, 0.25, 50.0));
    }
    Ok(cameras)
}

fn qvec_to_rotmat(qw: f32, qx: f32, qy: f32, qz: f32) -> [[f32; 3]; 3] {
    let norm = (qw * qw + qx * qx + qy * qy + qz * qz).sqrt();
    let (qw, qx, qy, qz) = if norm > 1e-8 {
        (qw / norm, qx / norm, qy / norm, qz / norm)
    } else {
        (1.0, 0.0, 0.0, 0.0)
    };

    [
        [
            1.0 - 2.0 * qy * qy - 2.0 * qz * qz,
            2.0 * qx * qy - 2.0 * qw * qz,
            2.0 * qx * qz + 2.0 * qw * qy,
        ],
        [
            2.0 * qx * qy + 2.0 * qw * qz,
            1.0 - 2.0 * qx * qx - 2.0 * qz * qz,
            2.0 * qy * qz - 2.0 * qw * qx,
        ],
        [
            2.0 * qx * qz - 2.0 * qw * qy,
            2.0 * qy * qz + 2.0 * qw * qx,
            1.0 - 2.0 * qx * qx - 2.0 * qy * qy,
        ],
    ]
}

fn colmap_camera_center(qw: f32, qx: f32, qy: f32, qz: f32, tx: f32, ty: f32, tz: f32) -> [f32; 3] {
    let rot = qvec_to_rotmat(qw, qx, qy, qz);
    let t = [tx, ty, tz];

    [
        -(rot[0][0] * t[0] + rot[1][0] * t[1] + rot[2][0] * t[2]),
        -(rot[0][1] * t[0] + rot[1][1] * t[1] + rot[2][1] * t[2]),
        -(rot[0][2] * t[0] + rot[1][2] * t[1] + rot[2][2] * t[2]),
    ]
}

fn read_images_bin(
    path: &std::path::Path,
    camera_params: &std::collections::HashMap<u32, (f32, f32, f32, f32)>,
) -> Result<Vec<ColmapCamera>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开 images.bin: {}", e))?;
    let mut reader = BufReader::new(file);
    let mut num_bytes = [0u8; 8];
    reader
        .read_exact(&mut num_bytes)
        .map_err(|e| format!("读取图片数失败: {}", e))?;
    let num_images = u64::from_le_bytes(num_bytes) as usize;
    let mut cameras = Vec::with_capacity(num_images);

    for _ in 0..num_images {
        let mut header = [0u8; 64]; // image_id(u32=4) + qw/qx/qy/qz(f64*4=32) + tx/ty/tz(f64*3=24) + camera_id(u32=4) = 64
        reader
            .read_exact(&mut header)
            .map_err(|e| format!("读取图片位姿失败: {}", e))?;
        let image_id = u32::from_le_bytes(header[0..4].try_into().unwrap());
        let qw = f64::from_le_bytes(header[4..12].try_into().unwrap()) as f32;
        let qx = f64::from_le_bytes(header[12..20].try_into().unwrap()) as f32;
        let qy = f64::from_le_bytes(header[20..28].try_into().unwrap()) as f32;
        let qz = f64::from_le_bytes(header[28..36].try_into().unwrap()) as f32;
        let tx = f64::from_le_bytes(header[36..44].try_into().unwrap()) as f32;
        let ty = f64::from_le_bytes(header[44..52].try_into().unwrap()) as f32;
        let tz = f64::from_le_bytes(header[52..60].try_into().unwrap()) as f32;
        let camera_id = u32::from_le_bytes(header[60..64].try_into().unwrap());

        // Skip image name (null-terminated string)
        loop {
            let mut byte = [0u8; 1];
            reader
                .read_exact(&mut byte)
                .map_err(|e| format!("读取图片名失败: {}", e))?;
            if byte[0] == 0 {
                break;
            }
        }

        // Skip points2D
        let mut pts2d_len_bytes = [0u8; 8];
        reader
            .read_exact(&mut pts2d_len_bytes)
            .map_err(|e| format!("读取2D点数失败: {}", e))?;
        let num_pts2d = u64::from_le_bytes(pts2d_len_bytes) as usize;
        // Each point2D: x(f64) + y(f64) + point3D_id(u64) = 24 bytes
        let skip = num_pts2d * 24;
        let mut skip_buf = vec![0u8; skip];
        if skip > 0 {
            reader
                .read_exact(&mut skip_buf)
                .map_err(|e| format!("跳过2D点失败: {}", e))?;
        }

        let default_params = (std::f32::consts::PI / 3.0, 1.55, 0.25, 50.0);
        let (fov, aspect, near, far) = camera_params.get(&camera_id).unwrap_or(&default_params);
        let center = colmap_camera_center(qw, qx, qy, qz, tx, ty, tz);

        cameras.push(ColmapCamera {
            id: image_id,
            position: center,
            rotation: [qw, qx, qy, qz],
            fov: *fov,
            aspect: *aspect,
            near: *near,
            far: *far,
        });
    }

    Ok(cameras)
}

/// Read COLMAP points3D.bin and return point positions + colors + camera poses.
#[tauri::command]
fn read_colmap_points(
    dir: String,
    points_path: Option<String>,
    max_points: Option<usize>,
) -> Result<ColmapPointCloud, String> {
    let points_path = points_path
        .and_then(|path| {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(std::path::PathBuf::from(trimmed))
            }
        })
        .or_else(|| find_bin(&dir, &["points3D.bin"]))
        .ok_or_else(|| format!("在 {} 中未找到 points3D.bin", dir))?;

    let file = std::fs::File::open(&points_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut reader = BufReader::new(file);

    let mut num_bytes = [0u8; 8];
    reader
        .read_exact(&mut num_bytes)
        .map_err(|e| format!("读取点数失败: {}", e))?;
    let total_points = u64::from_le_bytes(num_bytes) as usize;
    let point_budget = max_points.unwrap_or(0);
    let sample_stride = if point_budget > 0 && total_points > point_budget {
        total_points.div_ceil(point_budget).max(1)
    } else {
        1
    };
    let expected_points = if sample_stride > 1 {
        total_points.div_ceil(sample_stride).min(point_budget)
    } else {
        total_points
    };

    let mut points = Vec::with_capacity(expected_points * 3);
    let mut colors = Vec::with_capacity(expected_points * 3);

    for index in 0..total_points {
        let mut header = [0u8; 32];
        reader
            .read_exact(&mut header)
            .map_err(|e| format!("读取点坐标失败: {}", e))?;

        let x = f64::from_le_bytes(header[8..16].try_into().unwrap()) as f32;
        let y = f64::from_le_bytes(header[16..24].try_into().unwrap()) as f32;
        let z = f64::from_le_bytes(header[24..32].try_into().unwrap()) as f32;

        let mut color_bytes = [0u8; 3];
        reader
            .read_exact(&mut color_bytes)
            .map_err(|e| format!("读取颜色失败: {}", e))?;

        let keep_point = index % sample_stride == 0 && points.len() / 3 < expected_points;
        if keep_point {
            points.push(x);
            points.push(y);
            points.push(z);
            colors.push(color_bytes[0] as f32 / 255.0);
            colors.push(color_bytes[1] as f32 / 255.0);
            colors.push(color_bytes[2] as f32 / 255.0);
        }

        let mut error_bytes = [0u8; 8];
        reader
            .read_exact(&mut error_bytes)
            .map_err(|e| format!("读取误差失败: {}", e))?;
        let mut track_len_bytes = [0u8; 8];
        reader
            .read_exact(&mut track_len_bytes)
            .map_err(|e| format!("读取轨迹长度失败: {}", e))?;
        let track_len = u64::from_le_bytes(track_len_bytes) as usize;
        if track_len > 0 {
            reader
                .seek(SeekFrom::Current((track_len * 8) as i64))
                .map_err(|e| format!("跳过轨迹失败: {}", e))?;
        }
    }

    let camera_params = find_bin(&dir, &["cameras.bin"])
        .and_then(|p| read_cameras_bin(&p).ok())
        .unwrap_or_default();

    let cameras = find_bin(&dir, &["images.bin"])
        .and_then(|p| read_images_bin(&p, &camera_params).ok())
        .unwrap_or_default();

    Ok(ColmapPointCloud {
        points,
        colors,
        num_points: expected_points,
        total_points,
        sampled: sample_stride > 1,
        cameras,
    })
}
#[tauri::command]
fn apply_lfs_densify_result(output_dir: String, dense_points_path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&output_dir)
        .canonicalize()
        .map_err(|e| format!("无法读取输出目录: {}", e))?;
    let dense_path = std::path::PathBuf::from(&dense_points_path)
        .canonicalize()
        .map_err(|e| format!("无法读取致密化点云: {}", e))?;
    if !dense_path.starts_with(&root) {
        return Err("致密化结果不在当前项目目录内".to_string());
    }

    let points_path = find_bin(&output_dir, &["points3D.bin"])
        .ok_or_else(|| format!("在 {} 中未找到 points3D.bin", output_dir))?;
    let sparse_dir = points_path
        .parent()
        .ok_or_else(|| "无法定位 sparse 目录".to_string())?;
    let backup_path = sparse_dir.join("points3D_sparse_original.bin");

    if !backup_path.exists() {
        std::fs::copy(&points_path, &backup_path)
            .map_err(|e| format!("备份原始点云失败: {}", e))?;
    }
    std::fs::copy(&dense_path, &points_path).map_err(|e| format!("应用致密化点云失败: {}", e))?;
    let _ = std::fs::remove_file(&dense_path);
    if let Some(parent) = dense_path.parent() {
        let dense_ply = parent.join("points3D_dense.ply");
        if dense_ply.exists() {
            let _ = std::fs::remove_file(dense_ply);
        }
    }
    let previous = read_densify_state(&root);
    let _ = write_densify_state(
        &root,
        &DensifyPersistedState {
            status: "applied".to_string(),
            message: "致密化结果已应用到点云文件".to_string(),
            result: previous.and_then(|state| state.result),
            log_path: read_densify_state(&root)
                .map(|state| state.log_path)
                .unwrap_or_default(),
            updated_at: now_millis(),
        },
    );
    Ok(())
}

#[tauri::command]
fn discard_lfs_densify_result(output_dir: String, dense_points_path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&output_dir)
        .canonicalize()
        .map_err(|e| format!("无法读取输出目录: {}", e))?;
    let dense_path = std::path::PathBuf::from(&dense_points_path)
        .canonicalize()
        .map_err(|e| format!("无法读取致密化点云: {}", e))?;
    if !dense_path.starts_with(&root) {
        return Err("致密化结果不在当前项目目录内".to_string());
    }
    if dense_path.exists() {
        std::fs::remove_file(&dense_path).map_err(|e| format!("删除致密化结果失败: {}", e))?;
    }
    if let Some(parent) = dense_path.parent() {
        let dense_ply = parent.join("points3D_dense.ply");
        if dense_ply.exists() {
            let _ = std::fs::remove_file(dense_ply);
        }
    }
    let previous = read_densify_state(&root);
    let _ = write_densify_state(
        &root,
        &DensifyPersistedState {
            status: "discarded".to_string(),
            message: "已丢弃这次致密化结果".to_string(),
            result: previous.as_ref().and_then(|state| state.result.clone()),
            log_path: previous.map(|state| state.log_path).unwrap_or_default(),
            updated_at: now_millis(),
        },
    );
    Ok(())
}

fn remove_file_if_exists(path: &std::path::Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn densify_workspace(output_dir: &std::path::Path) -> std::path::PathBuf {
    output_dir.join("workspace")
}

fn densify_state_path(output_dir: &std::path::Path) -> std::path::PathBuf {
    densify_workspace(output_dir).join("lfs_densify_state.json")
}

fn densify_logs_dir(output_dir: &std::path::Path) -> std::path::PathBuf {
    densify_workspace(output_dir).join("logs")
}

fn read_densify_state(output_dir: &std::path::Path) -> Option<DensifyPersistedState> {
    let path = densify_state_path(output_dir);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_densify_state(
    output_dir: &std::path::Path,
    state: &DensifyPersistedState,
) -> Result<(), String> {
    let workspace = densify_workspace(output_dir);
    std::fs::create_dir_all(&workspace).map_err(|e| format!("创建工作目录失败: {}", e))?;
    let path = densify_state_path(output_dir);
    let tmp = path.with_extension("json.tmp");
    let text =
        serde_json::to_string_pretty(state).map_err(|e| format!("序列化致密化状态失败: {}", e))?;
    std::fs::write(&tmp, text).map_err(|e| format!("写入致密化状态失败: {}", e))?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("更新致密化状态失败: {}", e))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存致密化状态失败: {}", e))?;
    Ok(())
}

fn clean_old_densify_logs(log_dir: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("log") {
                return None;
            }
            let modified = entry.metadata().and_then(|value| value.modified()).ok()?;
            Some((modified, path))
        })
        .collect();
    files.sort_by_key(|(modified, _)| *modified);
    let remove_count = files.len().saturating_sub(keep);
    for (_, path) in files.into_iter().take(remove_count) {
        let _ = std::fs::remove_file(path);
    }
}

fn create_densify_log_file(
    output_dir: &std::path::Path,
    task: &str,
) -> Result<std::path::PathBuf, String> {
    let log_dir = densify_logs_dir(output_dir);
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("创建日志目录失败: {}", e))?;
    clean_old_densify_logs(&log_dir, 12);
    Ok(log_dir.join(format!("densify-{}-{}.log", task, now_millis())))
}

fn create_densify_env_log_file(
    root: &std::path::Path,
    task: &str,
) -> Result<std::path::PathBuf, String> {
    let log_dir = root.join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("创建致密化环境日志目录失败: {}", e))?;
    clean_old_densify_logs(&log_dir, 12);
    Ok(log_dir.join(format!("densify-{}-{}.log", task, now_millis())))
}

#[tauri::command]
fn get_lfs_densify_state(output_dir: String) -> Result<Option<DensifyPersistedState>, String> {
    let root = std::path::PathBuf::from(&output_dir)
        .canonicalize()
        .map_err(|e| format!("无法读取输出目录: {}", e))?;
    if let Some(mut state) = read_densify_state(&root) {
        if state.status == "running" {
            state.status = "stopped".to_string();
            state.message = "上次致密化任务未正常结束".to_string();
            state.updated_at = now_millis();
            let _ = write_densify_state(&root, &state);
        }
        Ok(Some(state))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn read_lfs_densify_log_tail(
    output_dir: String,
    log_path: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&output_dir)
        .canonicalize()
        .map_err(|e| format!("无法读取输出目录: {}", e))?;
    let path = std::path::PathBuf::from(log_path)
        .canonicalize()
        .map_err(|e| format!("无法读取致密化日志: {}", e))?;
    if !path.starts_with(&root) {
        return Err("日志文件不在当前项目目录内".to_string());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取致密化日志失败: {}", e))?;
    let lines: Vec<String> = text.lines().map(|line| line.to_string()).collect();
    let keep = max_lines.unwrap_or(220).max(1);
    let start = lines.len().saturating_sub(keep);
    Ok(lines[start..].to_vec())
}

#[tauri::command]
fn get_lfs_densify_pending_result(output_dir: String) -> Result<Option<DensifyRunResult>, String> {
    let root = std::path::PathBuf::from(&output_dir)
        .canonicalize()
        .map_err(|e| format!("无法读取输出目录: {}", e))?;
    let points_path = find_bin(&output_dir, &["points3D.bin"])
        .ok_or_else(|| format!("在 {} 中未找到 points3D.bin", output_dir))?;
    let sparse_dir = points_path
        .parent()
        .ok_or_else(|| "无法定位 sparse 目录".to_string())?;
    remove_file_if_exists(&sparse_dir.join("points3D_dense.bin.tmp"));
    remove_file_if_exists(&sparse_dir.join("points3D.bin.tmp"));

    let dense_path = sparse_dir.join("points3D_dense.bin");
    if !dense_path.exists() {
        return Ok(None);
    }
    let dense_path = dense_path
        .canonicalize()
        .map_err(|e| format!("无法读取致密化结果: {}", e))?;
    if !dense_path.starts_with(&root) {
        return Ok(None);
    }

    let backup_path = sparse_dir.join("points3D_sparse_original.bin");
    let original_points = if backup_path.exists() {
        count_colmap_points_bin(&backup_path)?
    } else {
        count_colmap_points_bin(&points_path)?
    };
    let current_points = count_colmap_points_bin(&points_path)?;
    let merged_points = count_colmap_points_bin(&dense_path)?;

    if backup_path.exists() && current_points == merged_points {
        return Ok(None);
    }
    if merged_points <= original_points {
        return Ok(None);
    }

    let result = DensifyRunResult {
        original_points,
        dense_points: merged_points - original_points,
        merged_points,
        output_points_path: dense_path.to_string_lossy().to_string(),
        replaced_points_bin: false,
        dense_ply_path: String::new(),
        backup_points_path: backup_path.to_string_lossy().to_string(),
        roma: String::new(),
        max_points: 0,
    };
    let previous = read_densify_state(&root);
    if previous
        .as_ref()
        .map(|state| state.status.as_str() != "completed_unconfirmed")
        .unwrap_or(true)
    {
        let _ = write_densify_state(
            &root,
            &DensifyPersistedState {
                status: "completed_unconfirmed".to_string(),
                message: "发现未确认的致密化结果".to_string(),
                result: Some(result.clone()),
                log_path: previous.map(|state| state.log_path).unwrap_or_default(),
                updated_at: now_millis(),
            },
        );
    }

    Ok(Some(result))
}

/// Normalize a path for the webview asset protocol.
///
/// Tauri's `convertFileSrc` mishandles Windows backslash paths (see
/// tauri-apps/tauri#8244), so we hand the frontend forward-slash paths instead.
fn web_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.creation_flags(0x08000000);
        let _ = cmd
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

struct ChildProcessGuard {
    child: Option<Child>,
}

impl Drop for ChildProcessGuard {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            kill_process_tree(child.id());
            let _ = child.wait();
        }
    }
}

fn run_guarded_command(mut command: Command) -> bool {
    let child = command.stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    let Ok(child) = child else {
        return false;
    };
    let mut guard = ChildProcessGuard { child: Some(child) };
    let status = guard.child.as_mut().and_then(|child| child.wait().ok());
    guard.child = None;
    status.map(|value| value.success()).unwrap_or(false)
}

fn locate_densify_plugin_path(root: &std::path::Path) -> std::path::PathBuf {
    let candidates = [
        root.join("tools").join("lichtfeld-densification-plugin"),
        root.join("third_party")
            .join("lichtfeld-densification-plugin"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("densify.py").exists())
        .unwrap_or_else(|| root.join("tools").join("lichtfeld-densification-plugin"))
}

fn densify_env_root(app: &AppHandle) -> std::path::PathBuf {
    let _ = app;
    tool_resolver::resolve_app_root().join("densify")
}

fn plain_windows_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", stripped)
    } else if let Some(stripped) = text.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        text.into_owned()
    }
}

fn run_output(mut cmd: Command) -> Result<std::process::Output, String> {
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.output().map_err(|e| format!("启动命令失败: {}", e))
}

fn command_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{}\n{}", stdout, stderr)
    }
}

fn hash_path_state(path: &std::path::Path, hasher: &mut DefaultHasher) {
    path.to_string_lossy().hash(hasher);
    match std::fs::metadata(path) {
        Ok(metadata) => {
            metadata.len().hash(hasher);
            metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis())
                .hash(hasher);
        }
        Err(_) => {
            0u8.hash(hasher);
        }
    }
}

fn densify_env_signature(
    root: &std::path::Path,
    python_path: &std::path::Path,
    plugin_path: &std::path::Path,
) -> String {
    let mut hasher = DefaultHasher::new();
    hash_path_state(python_path, &mut hasher);
    hash_path_state(&plugin_path.join("densify.py"), &mut hasher);
    hash_path_state(
        &tool_resolver::resolve_script_path("scripts/run_lichtfeld_densify_standalone.py"),
        &mut hasher,
    );
    hash_path_state(&root.join(".venv-densify").join("pyvenv.cfg"), &mut hasher);
    format!("{:016x}", hasher.finish())
}

fn densify_env_cache() -> &'static Mutex<Option<(String, DensifyEnvStatus)>> {
    static CACHE: OnceLock<Mutex<Option<(String, DensifyEnvStatus)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn emit_densify_task(
    app: &AppHandle,
    task: &str,
    kind: &str,
    message: &str,
    progress: Option<f64>,
) {
    let _ = app.emit(
        "densify:task",
        serde_json::json!({
            "task": task,
            "kind": kind,
            "message": message,
            "progress": progress,
        }),
    );
}

fn parse_tqdm_percent(line: &str) -> Option<f64> {
    let before_bar = line.split("%|").next()?.trim();
    let token = before_bar.split_whitespace().last()?;
    token.parse::<f64>().ok()
}

fn run_streaming_densify_command(
    mut cmd: Command,
    app: AppHandle,
    task: &'static str,
    log_path: Option<std::path::PathBuf>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    {
        let pid = state.densify_pid.lock().map_err(|e| e.to_string())?;
        if pid.is_some() {
            return Err("已有致密化相关任务正在运行".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.env("PYTHONIOENCODING", "utf-8:replace")
        .env("PYTHONUTF8", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env("PIP_NO_INPUT", "1")
        .env("PIP_PROGRESS_BAR", "off");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动命令失败: {}", e))?;
    let pid = child.id();
    {
        let mut active = state.densify_pid.lock().map_err(|e| e.to_string())?;
        *active = Some(pid);
    }
    emit_densify_task(&app, task, "start", "任务已启动", Some(0.0));

    let output_text = Arc::new(Mutex::new(String::new()));
    let log_file = if let Some(path) = &log_path {
        Some(Arc::new(Mutex::new(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|e| format!("打开致密化日志失败: {}", e))?,
        )))
    } else {
        None
    };
    let mut readers = Vec::new();

    if let Some(stream) = child.stdout.take() {
        let app_for_thread = app.clone();
        let output_for_thread = Arc::clone(&output_text);
        let log_for_thread = log_file.clone();
        readers.push(thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut text) = output_for_thread.lock() {
                    text.push_str(&line);
                    text.push('\n');
                }
                if let Some(file) = &log_for_thread {
                    if let Ok(mut file) = file.lock() {
                        let _ = writeln!(file, "{}", line);
                    }
                }
                if let Some(value) = line.trim().strip_prefix("PROGRESS:") {
                    let mut parts = value.trim().splitn(2, ':');
                    let progress_text = parts.next().unwrap_or("").trim();
                    let message = parts.next().unwrap_or(progress_text).trim();
                    let progress = progress_text.parse::<f64>().ok();
                    emit_densify_task(&app_for_thread, task, "progress", message, progress);
                } else if task == "run" && line.contains("%|") {
                    if let Some(download_progress) = parse_tqdm_percent(&line) {
                        let mapped_progress = 10.0 + download_progress.clamp(0.0, 100.0) * 0.2;
                        emit_densify_task(
                            &app_for_thread,
                            task,
                            "progress",
                            "正在下载 RoMa 权重",
                            Some(mapped_progress),
                        );
                    }
                    emit_densify_task(&app_for_thread, task, "stdout", &line, None);
                } else {
                    emit_densify_task(&app_for_thread, task, "stdout", &line, None);
                }
            }
        }));
    }

    if let Some(stream) = child.stderr.take() {
        let app_for_thread = app.clone();
        let output_for_thread = Arc::clone(&output_text);
        let log_for_thread = log_file.clone();
        readers.push(thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut text) = output_for_thread.lock() {
                    text.push_str(&line);
                    text.push('\n');
                }
                if let Some(file) = &log_for_thread {
                    if let Ok(mut file) = file.lock() {
                        let _ = writeln!(file, "{}", line);
                    }
                }
                emit_densify_task(&app_for_thread, task, "stderr", &line, None);
            }
        }));
    }

    let status = child.wait().map_err(|e| format!("等待命令失败: {}", e));
    for reader in readers {
        let _ = reader.join();
    }

    let should_clear = state
        .densify_pid
        .lock()
        .map(|mut active| {
            if *active == Some(pid) {
                *active = None;
                true
            } else {
                false
            }
        })
        .unwrap_or(false);

    let text = output_text
        .lock()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    match status {
        Ok(status) if status.success() => {
            emit_densify_task(&app, task, "done", "任务完成", Some(100.0));
            Ok(text)
        }
        Ok(status) => {
            let stopped = !should_clear;
            let message = if stopped {
                "任务已停止".to_string()
            } else if text.is_empty() {
                format!("命令退出码: {}", status)
            } else {
                text.clone()
            };
            emit_densify_task(
                &app,
                task,
                if stopped { "stopped" } else { "error" },
                &message,
                None,
            );
            Err(message)
        }
        Err(error) => {
            emit_densify_task(&app, task, "error", &error, None);
            Err(error)
        }
    }
}

pub(crate) struct AppState {
    pipeline: Mutex<PipelineState>,
    densify_pid: Mutex<Option<u32>>,
}

#[tauri::command]
fn start_pipeline(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    python_exe: String,
    script: String,
    args: Vec<String>,
) -> Result<String, String> {
    let mut pipeline = state.pipeline.lock().map_err(|e| e.to_string())?;
    pipeline.start(app, &python_exe, &script, &args)?;
    Ok("Pipeline started".into())
}

#[tauri::command]
fn cancel_pipeline(state: State<'_, AppState>) -> Result<String, String> {
    let mut pipeline = state.pipeline.lock().map_err(|e| e.to_string())?;
    pipeline.cancel()?;
    Ok("Pipeline cancelled".into())
}

#[tauri::command]
fn open_output_folder(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| format!("Failed to open folder: {}", e))
}

/// Apply a post-process axis correction to an existing COLMAP sparse model.
#[tauri::command]
async fn apply_colmap_axis_flip(
    python_exe: String,
    output_dir: String,
    axis: String,
) -> Result<String, String> {
    let axis = axis.trim().to_lowercase();
    if !matches!(axis.as_str(), "x" | "y" | "z") {
        return Err("axis must be x, y, or z".into());
    }
    let python = tool_resolver::resolve_python(&python_exe);
    tauri::async_runtime::spawn_blocking(move || {
        let script_path = tool_resolver::resolve_script_path("scripts/postprocess_colmap_axis.py");
        let mut cmd = Command::new(&python);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let output = cmd
            .arg(script_path)
            .arg("--output-dir")
            .arg(output_dir)
            .arg("--flip-axis")
            .arg(axis)
            .output()
            .map_err(|e| format!("启动轴向后处理失败: {}", e))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    })
    .await
    .map_err(|e| format!("轴向后处理线程失败: {}", e))?
}

/// Estimate the ground plane in an existing COLMAP sparse model and rotate it
/// so the selected viewer axis points upward.
#[tauri::command]
async fn apply_colmap_ground_alignment(
    python_exe: String,
    output_dir: String,
    up_axis: String,
) -> Result<String, String> {
    let up_axis = up_axis.trim().to_uppercase();
    if !matches!(up_axis.as_str(), "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z") {
        return Err("up_axis must be one of +X, -X, +Y, -Y, +Z, -Z".into());
    }
    let python = tool_resolver::resolve_python(&python_exe);
    tauri::async_runtime::spawn_blocking(move || {
        let script_path = tool_resolver::resolve_script_path("scripts/postprocess_colmap_axis.py");
        let mut cmd = Command::new(&python);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let output = cmd
            .arg(script_path)
            .arg("--output-dir")
            .arg(output_dir)
            .arg("--align-ground")
            .arg("--up-axis")
            .arg(up_axis)
            .output()
            .map_err(|e| format!("启动地面对齐后处理失败: {}", e))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    })
    .await
    .map_err(|e| format!("地面对齐后处理线程失败: {}", e))?
}

#[tauri::command]
async fn check_lfs_densify_env(
    app: AppHandle,
    python_exe: String,
    force: Option<bool>,
) -> Result<DensifyEnvStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = densify_env_root(&app);
        let plugin_path = locate_densify_plugin_path(&root);
        let python_path = if python_exe.trim().is_empty() {
            tool_resolver::locate_densify_python(&root)
        } else {
            std::path::PathBuf::from(python_exe.trim())
        };
        let signature = densify_env_signature(&root, &python_path, &plugin_path);
        if !force.unwrap_or(false) {
            if let Ok(cache) = densify_env_cache().lock() {
                if let Some((cached_signature, cached_status)) = cache.as_ref() {
                    if cached_signature == &signature {
                        return Ok(cached_status.clone());
                    }
                }
            }
        }
        let plugin_ok = plugin_path.join("densify.py").exists();
        let python_ok = python_path.exists();
        let mut messages = Vec::new();
        if !plugin_ok {
            messages.push("未找到 LichtFeld densification 插件".to_string());
        }
        if !python_ok {
            messages.push("未找到 .venv-densify Python".to_string());
        }

        let deps_ok = if python_ok {
            let mut deps = Command::new(&python_path);
            deps.arg("-c")
                .arg("import torch, torchvision, pycolmap, PIL, scipy, tqdm, einops, rich, open3d; print('ok')");
            match run_output(deps) {
                Ok(output) if output.status.success() => true,
                Ok(output) => {
                    messages.push(command_text(&output));
                    false
                }
                Err(error) => {
                    messages.push(error);
                    false
                }
            }
        } else {
            false
        };

        let runner_ok = if python_ok && plugin_ok {
            let mut runner = Command::new(&python_path);
            runner
                .arg(tool_resolver::resolve_script_path(
                    "scripts/run_lichtfeld_densify_standalone.py",
                ))
                .arg("--plugin-dir")
                .arg(&plugin_path)
                .arg("--help");
            match run_output(runner) {
                Ok(output) if output.status.success() => {
                    let text = command_text(&output);
                    text.contains("--scene_root") && text.contains("--roma_setting")
                }
                Ok(output) => {
                    messages.push(command_text(&output));
                    false
                }
                Err(error) => {
                    messages.push(error);
                    false
                }
            }
        } else {
            false
        };

        let message = if plugin_ok && python_ok && deps_ok && runner_ok {
            "致密化环境可用".to_string()
        } else if messages.is_empty() {
            "致密化环境未配置完整".to_string()
        } else {
            messages.join("\n")
        };

        let status = DensifyEnvStatus {
            plugin_ok,
            python_ok,
            deps_ok,
            runner_ok,
            plugin_path: plugin_path.to_string_lossy().into_owned(),
            python_path: python_path.to_string_lossy().into_owned(),
            message,
        };
        if let Ok(mut cache) = densify_env_cache().lock() {
            *cache = Some((signature, status.clone()));
        }
        Ok(status)
    })
    .await
    .map_err(|e| format!("环境检查线程失败: {}", e))?
}

#[tauri::command]
async fn install_lfs_densify_env(app: AppHandle, use_cuda: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = densify_env_root(&app);
        let root_text = plain_windows_path(&root);
        let log_path = create_densify_env_log_file(&root, "install")?;
        let script = tool_resolver::resolve_script_path("scripts/install_lfs_densify.ps1");
        if !script.exists() {
            return Err(format!("未找到安装脚本: {}", script.display()));
        }
        let mut cmd = Command::new("powershell");
        cmd.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(script)
            .arg("-Root")
            .arg(root_text);
        if use_cuda {
            cmd.arg("-UseCudaTorch");
        }
        if let Ok(mut cache) = densify_env_cache().lock() {
            *cache = None;
        }
        let text = run_streaming_densify_command(cmd, app, "install", Some(log_path))?;
        if let Ok(mut cache) = densify_env_cache().lock() {
            *cache = None;
        }
        Ok(text)
    })
    .await
    .map_err(|e| format!("安装线程失败: {}", e))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_lfs_densify(
    app: AppHandle,
    output_dir: String,
    roma: String,
    max_points: i64,
    num_refs: f64,
    nns_per_ref: i64,
    matches_per_ref: i64,
    certainty_thresh: f64,
    image_filter: String,
    roi_start: f64,
    roi_end: f64,
) -> Result<DensifyRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = densify_env_root(&app);
        let output_root = std::path::PathBuf::from(&output_dir)
            .canonicalize()
            .map_err(|e| format!("无法读取输出目录: {}", e))?;
        let log_path = create_densify_log_file(&output_root, "run")?;
        let log_path_text = log_path.to_string_lossy().to_string();
        let _ = write_densify_state(
            &output_root,
            &DensifyPersistedState {
                status: "running".to_string(),
                message: "正在运行 LichtFeld 致密化".to_string(),
                result: None,
                log_path: log_path_text.clone(),
                updated_at: now_millis(),
            },
        );
        let python = tool_resolver::locate_densify_python(&root);
        if !python.exists() {
            let message = "未找到 .venv-densify Python，请先一键配置环境".to_string();
            let _ = write_densify_state(
                &output_root,
                &DensifyPersistedState {
                    status: "failed".to_string(),
                    message: message.clone(),
                    result: None,
                    log_path: log_path_text.clone(),
                    updated_at: now_millis(),
                },
            );
            return Err(message);
        }
        let plugin = locate_densify_plugin_path(&root);
        if !plugin.join("densify.py").exists() {
            let message = "未找到 LichtFeld densification 插件，请先一键配置环境".to_string();
            let _ = write_densify_state(
                &output_root,
                &DensifyPersistedState {
                    status: "failed".to_string(),
                    message: message.clone(),
                    result: None,
                    log_path: log_path_text.clone(),
                    updated_at: now_millis(),
                },
            );
            return Err(message);
        }
        let roma = if ["turbo", "fast", "base", "high", "precise"].contains(&roma.as_str()) {
            roma
        } else {
            "fast".to_string()
        };
        let max_points_text = max_points.max(0).to_string();
        let num_refs_text = if num_refs > 0.0 { num_refs } else { 8.0 }.to_string();
        let nns_per_ref_text = nns_per_ref.max(1).to_string();
        let matches_per_ref_text = matches_per_ref.max(100).to_string();
        let certainty_thresh_text = certainty_thresh.clamp(0.0, 1.0).to_string();
        let image_filter = if ["all", "cube_all", "front", "hd", "front_plus_hd"]
            .contains(&image_filter.as_str())
        {
            image_filter
        } else {
            "front_plus_hd".to_string()
        };
        let roi_start_text = roi_start.clamp(0.0, 1.0).to_string();
        let roi_end_text = roi_end.clamp(0.0, 1.0).to_string();

        let mut cmd = Command::new(tool_resolver::resolve_python(""));
        cmd.arg(tool_resolver::resolve_script_path(
            "scripts/run_lfs_densify_viewer.py",
        ))
        .arg("--output-dir")
        .arg(output_dir)
        .arg("--python-exe")
        .arg(python)
        .arg("--plugin-dir")
        .arg(plugin)
        .arg("--roma")
        .arg(roma)
        .arg("--max-points")
        .arg(max_points_text)
        .arg("--num-refs")
        .arg(num_refs_text)
        .arg("--nns-per-ref")
        .arg(nns_per_ref_text)
        .arg("--matches-per-ref")
        .arg(matches_per_ref_text)
        .arg("--certainty-thresh")
        .arg(certainty_thresh_text)
        .arg("--image-filter")
        .arg(image_filter)
        .arg("--roi-start")
        .arg(roi_start_text)
        .arg("--roi-end")
        .arg(roi_end_text);
        let text = match run_streaming_densify_command(cmd, app, "run", Some(log_path.clone())) {
            Ok(text) => text,
            Err(error) => {
                let status = if error.contains("任务已停止") {
                    "stopped"
                } else {
                    "failed"
                };
                let _ = write_densify_state(
                    &output_root,
                    &DensifyPersistedState {
                        status: status.to_string(),
                        message: error.clone(),
                        result: None,
                        log_path: log_path_text,
                        updated_at: now_millis(),
                    },
                );
                return Err(error);
            }
        };
        let result_line = match text
            .lines()
            .rev()
            .find_map(|line| line.trim().strip_prefix("DENSIFY_RESULT:"))
        {
            Some(line) => line,
            None => {
                let message = "致密化完成但未返回结果摘要".to_string();
                let _ = write_densify_state(
                    &output_root,
                    &DensifyPersistedState {
                        status: "failed".to_string(),
                        message: message.clone(),
                        result: None,
                        log_path: log_path_text,
                        updated_at: now_millis(),
                    },
                );
                return Err(message);
            }
        };
        let result = serde_json::from_str::<DensifyRunResult>(result_line)
            .map_err(|e| format!("解析致密化结果失败: {}\n{}", e, text))?;
        let _ = write_densify_state(
            &output_root,
            &DensifyPersistedState {
                status: "completed_unconfirmed".to_string(),
                message: "致密化完成，等待确认应用或丢弃".to_string(),
                result: Some(result.clone()),
                log_path: log_path_text,
                updated_at: now_millis(),
            },
        );
        Ok(result)
    })
    .await
    .map_err(|e| format!("致密化线程失败: {}", e))?
}

#[tauri::command]
fn stop_lfs_densify_task(state: State<'_, AppState>) -> Result<bool, String> {
    let pid = {
        let mut active = state.densify_pid.lock().map_err(|e| e.to_string())?;
        active.take()
    };
    if let Some(pid) = pid {
        kill_process_tree(pid);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn probe_video_duration(path: String) -> f64 {
    use std::process::Command;
    let src = match std::fs::canonicalize(&path) {
        Ok(a) => a,
        Err(_) => return 0.0,
    };
    let mut cmd = Command::new(tool_resolver::locate_ffprobe());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let out = cmd
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(&src)
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<f64>()
            .unwrap_or(0.0),
        Err(_) => 0.0,
    }
}

/// Extract a single frame from both lenses of a panoramic video at a given time.
///
/// Insta360 `.insv` files carry two video streams (front + back). HTML5 video
/// can't pick the second stream, and transcoding the whole 4K HEVC file is far
/// slower than realtime — so instead we extract one frame per lens on demand
/// when the user scrubs the timeline. Returns `[front_path, back_path]` as
/// browser-loadable temp jpgs (empty strings if a stream is missing).
#[tauri::command]
fn extract_pano_frame(path: String, time: f64) -> Vec<String> {
    use std::process::Command;

    let src = match std::fs::canonicalize(&path) {
        Ok(a) => a,
        Err(_) => return vec![String::new(), String::new()],
    };
    let key = src
        .to_string_lossy()
        .bytes()
        .fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
    let tmp_dir = std::env::temp_dir().join("xpano-frames");
    let _ = std::fs::create_dir_all(&tmp_dir);
    // Frame filenames include the time so concurrent scrubs don't clobber each other.
    let t_label = (time * 10.0).round() as i64;
    // Detect dual-lens sources. .insv (Insta360) and .osv (DJI 360) both carry
    // a second video stream, but they map front/back to different stream indices:
    //   Insta360 .insv:  stream 0 = front,  stream 1 = back
    //   DJI 360  .osv:   stream 0 = back,   stream 1 = front
    let is_osv = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("osv"))
        .unwrap_or(false);
    // Include format in cache key so OSV/INSV stream remapping doesn't reuse stale frames
    let fmt_tag = if is_osv { "osv" } else { "insv" };
    let front = tmp_dir.join(format!("{:x}_{}_{}_0.jpg", key, fmt_tag, t_label));
    let back = tmp_dir.join(format!("{:x}_{}_{}_1.jpg", key, fmt_tag, t_label));
    let has_dual_lens = if is_osv {
        true // DJI 360 always has dual lenses
    } else {
        let ffprobe = tool_resolver::locate_ffprobe();
        let mut probe_cmd = Command::new(&ffprobe);
        #[cfg(target_os = "windows")]
        probe_cmd.creation_flags(0x08000000);
        probe_cmd
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:1",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
            ])
            .arg(&src)
            .output()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false)
    };
    let ffmpeg = tool_resolver::locate_ffmpeg();
    let stamp = format!("{:.3}", time.max(0.0));
    // Swap stream mapping for OSV: front←stream 1, back←stream 0
    let (front_stream, back_stream): (&str, &str) = if is_osv {
        ("0:1", "0:0")
    } else {
        ("0:0", "0:1")
    };

    if !front.exists() {
        let mut command = Command::new(&ffmpeg);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        command
            .args(["-hide_banner", "-y", "-nostdin", "-hwaccel", "d3d11va"])
            .args(["-ss", &stamp])
            .arg("-i")
            .arg(&src)
            .args([
                "-map",
                front_stream,
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-2",
            ])
            .arg(&front);
        let _ = run_guarded_command(command);
    }
    if has_dual_lens && !back.exists() {
        let mut command = Command::new(&ffmpeg);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        command
            .args(["-hide_banner", "-y", "-nostdin", "-hwaccel", "d3d11va"])
            .args(["-ss", &stamp])
            .arg("-i")
            .arg(&src)
            .args(["-map", back_stream, "-frames:v", "1", "-vf", "scale=640:-2"])
            .arg(&back);
        let _ = run_guarded_command(command);
    }

    vec![
        if front.exists() {
            web_path(&front)
        } else {
            String::new()
        },
        if back.exists() {
            web_path(&back)
        } else {
            String::new()
        },
    ]
}

/// Start incremental thumbnail generation for a panoramic video.
///
/// Spawns a background thread that extracts frame pairs (front +, for insv, back)
/// starting at `from`, every `interval` seconds, for `count` frames. Each pair is
/// emitted as a `thumbgen:frame` event so the frontend can fill the timeline
/// progressively. Switching videos calls `stop_thumbgen` to cancel.
#[tauri::command]
fn start_thumbgen(
    app: AppHandle,
    state: State<Mutex<ThumbgenState>>,
    path: String,
    from: f64,
    interval: f64,
    count: usize,
) {
    thumbgen::start_batch(app, state.inner(), path, from, interval, count);
}

/// Cancel any in-flight thumbnail batch (called when the user switches videos).
#[tauri::command]
fn stop_thumbgen(state: State<Mutex<ThumbgenState>>) {
    state.inner().lock().unwrap().reset();
}

#[tauri::command]
fn detect_metashape() -> String {
    let candidates = [
        "E:\\FastProgram\\Metashape\\metashape.exe",
        "C:\\Program Files\\Agisoft\\Metashape Pro\\metashape.exe",
        "C:\\Program Files\\Agisoft\\Metashape\\metashape.exe",
    ];
    // Check env var first
    if let Ok(val) = std::env::var("XPANO_METASHAPE") {
        if std::path::Path::new(&val).exists() {
            return val;
        }
    }
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }
    "metashape.exe".to_string()
}

#[tauri::command]
fn window_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn window_close(window: tauri::Window) {
    let _ = window.close();
}

/// Clear the temp directories used for cached thumbnails and frame extracts.
/// Called at startup (guaranteed) and on graceful shutdown (best-effort).
/// Retries with backoff if deletion fails (thumbgen / ffmpeg may still hold file handles).
fn clear_temp_cache() {
    for dir in &["xpano-thumbs", "xpano-frames"] {
        let path = std::env::temp_dir().join(dir);
        if !path.exists() {
            continue;
        }
        for attempt in 0..3 {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => break,
                Err(_) if attempt < 2 => {
                    std::thread::sleep(std::time::Duration::from_millis(80 + attempt * 80));
                }
                Err(_) => {} // give up after 3 attempts — startup will catch it next time
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    clear_temp_cache();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            pipeline: Mutex::new(PipelineState::new()),
            densify_pid: Mutex::new(None),
        })
        .manage(Mutex::new(ThumbgenState::new()))
        .setup(|app| {
            tool_resolver::init(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    // Kill running pipeline and its entire process tree
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        let _ = state.pipeline.lock().map(|mut p| p.cancel());
                        if let Ok(mut pid) = state.densify_pid.lock() {
                            if let Some(pid) = pid.take() {
                                kill_process_tree(pid);
                            }
                        }
                    }
                    // Cancel any in-flight thumbnail generation to release file handles
                    if let Some(state) = window.app_handle().try_state::<Mutex<ThumbgenState>>() {
                        let _ = state.lock().map(|s| s.cancel());
                    }
                    clear_temp_cache();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_pipeline,
            cancel_pipeline,
            open_output_folder,
            apply_colmap_axis_flip,
            apply_colmap_ground_alignment,
            check_lfs_densify_env,
            install_lfs_densify_env,
            run_lfs_densify,
            get_lfs_densify_state,
            read_lfs_densify_log_tail,
            get_lfs_densify_pending_result,
            apply_lfs_densify_result,
            discard_lfs_densify_result,
            stop_lfs_densify_task,
            probe_video_duration,
            extract_pano_frame,
            start_thumbgen,
            stop_thumbgen,
            detect_metashape,
            read_colmap_points,
            window_minimize,
            window_toggle_maximize,
            window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
