use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::process_job::ProcessJob;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskProgressEvent {
    pub status: String,
    pub percent: f64,
    pub message: String,
    pub elapsed: u64,
    pub current: Option<u64>,
    pub total: Option<u64>,
    pub device: Option<String>,
    pub output_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskCompleteEvent {
    pub output_path: String,
}

#[derive(Clone, Serialize)]
pub struct MaskErrorEvent {
    pub error: String,
}

pub struct MaskProcessState {
    pid: Option<u32>,
    cancelled: Option<Arc<AtomicBool>>,
    job: Option<ProcessJob>,
    progress: Arc<Mutex<Option<MaskProgressEvent>>>,
}

impl MaskProcessState {
    pub fn new() -> Self {
        Self { pid: None, cancelled: None, job: None, progress: Arc::new(Mutex::new(None)) }
    }

    pub fn progress(&self) -> Option<MaskProgressEvent> {
        self.progress.lock().ok().and_then(|progress| progress.clone())
    }

    pub fn is_current_pid(&self, pid: u32) -> bool {
        self.pid == Some(pid)
    }

    pub fn clear_if_pid(&mut self, pid: u32) {
        if self.pid == Some(pid) {
            self.pid = None;
            self.cancelled = None;
            self.job = None;
        }
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        python_exe: &str,
        script: &str,
        args: &[String],
    ) -> Result<(), String> {
        let _ = self.cancel();
        let python = crate::tool_resolver::resolve_python(python_exe);
        let script_path = crate::tool_resolver::resolve_script_path(script);
        if !script_path.exists() {
            return Err(format!("遮罩脚本不存在: {}", script_path.display()));
        }

        let mut command = Command::new(&python);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        if let Some(root) = script_path.parent().and_then(|path| path.parent()) {
            command.env("PYTHONPATH", root);
        }
        command
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .arg(&script_path)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            format!("无法启动遮罩任务（Python: {}）: {}", python, error)
        })?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("无法读取遮罩任务标准输出")?;
        let stderr = child.stderr.take().ok_or("无法读取遮罩任务错误输出")?;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.pid = Some(pid);
        self.cancelled = Some(cancelled.clone());
        self.job = ProcessJob::new().and_then(|job| {
            job.assign_pid(pid)?;
            Ok(job)
        }).ok();
        if let Ok(mut progress) = self.progress.lock() {
            *progress = None;
        }

        let output_root = args.windows(2).find_map(|pair| {
            (pair[0] == "--output").then(|| std::path::PathBuf::from(&pair[1]))
        }).unwrap_or_default();
        let output_path = output_root.join("masks").to_string_lossy().into_owned();
        let log_path = output_root.join("logs").join("xpano_mask.log");
        let last_error = Arc::new(Mutex::new(None::<String>));
        let started = std::time::Instant::now();
        let _ = app.emit("mask:progress", MaskProgressEvent {
            status: String::new(), percent: 0.0,
            message: format!("日志文件: {}", log_path.display()), elapsed: 0,
            current: None, total: None, device: None, output_path: None,
        });

        let stdout_thread = {
            let app = app.clone();
            let last_error = last_error.clone();
            let latest_progress = self.progress.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
                    let decoded = String::from_utf8_lossy(&line);
                    let text = decoded.trim();
                    if text.is_empty() { continue; }
                    if let Some(raw) = text.strip_prefix("MASK_EVENT:") {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
                            let status = value.get("status").and_then(|v| v.as_str()).unwrap_or("running").to_string();
                            let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("正在处理遮罩").to_string();
                            if status == "error" {
                                if let Ok(mut error) = last_error.lock() { *error = Some(message.clone()); }
                            }
                            let event = MaskProgressEvent {
                                status,
                                percent: value.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0).clamp(0.0, 100.0),
                                message,
                                elapsed: value.get("elapsed").and_then(|v| v.as_u64()).unwrap_or_else(|| started.elapsed().as_secs()),
                                current: value.get("current").and_then(|v| v.as_u64()),
                                total: value.get("total").and_then(|v| v.as_u64()),
                                device: value.get("device").and_then(|v| v.as_str()).map(str::to_string),
                                output_path: value.get("outputPath").and_then(|v| v.as_str()).map(str::to_string),
                            };
                            if let Ok(mut progress) = latest_progress.lock() {
                                *progress = Some(event.clone());
                            }
                            let _ = app.emit("mask:progress", event);
                        }
                    } else {
                        let _ = app.emit("mask:progress", MaskProgressEvent {
                            status: String::new(), percent: 0.0, message: text.to_string(),
                            elapsed: started.elapsed().as_secs(), current: None, total: None,
                            device: None, output_path: None,
                        });
                    }
                }
            })
        };

        let stderr_thread = {
            let app = app.clone();
            let last_error = last_error.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                    let decoded = String::from_utf8_lossy(&line);
                    let text = decoded.trim();
                    if let Some(error) = text.strip_prefix("ERROR:") {
                        if let Ok(mut stored) = last_error.lock() { *stored = Some(error.trim().to_string()); }
                    }
                    if !text.is_empty() && !text.starts_with("ERROR:") {
                        let _ = app.emit("mask:progress", MaskProgressEvent {
                            status: String::new(), percent: 0.0, message: text.to_string(),
                            elapsed: started.elapsed().as_secs(), current: None, total: None,
                            device: None, output_path: None,
                        });
                    }
                }
            })
        };

        {
            let app = app.clone();
            let log_path_text = log_path.to_string_lossy().into_owned();
            std::thread::spawn(move || {
                let status = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                let was_cancelled = cancelled.load(Ordering::SeqCst);
                if is_current(&app, pid) {
                    match status {
                        Ok(_) if was_cancelled => {
                            let _ = app.emit("mask:error", MaskErrorEvent { error: "遮罩任务已取消".into() });
                        }
                        Ok(exit) if exit.success() => {
                            let _ = app.emit("mask:complete", MaskCompleteEvent { output_path });
                        }
                        Ok(exit) => {
                            let code = exit.code().map(|v| v.to_string()).unwrap_or_else(|| "unknown".into());
                            let detail = last_error.lock().ok().and_then(|error| error.clone())
                                .unwrap_or_else(|| format!("遮罩任务异常结束，退出码 {}", code));
                            let _ = app.emit("mask:error", MaskErrorEvent {
                                error: format!("{}（日志：{}）", detail, log_path_text),
                            });
                        }
                        Err(error) => {
                            let _ = app.emit("mask:error", MaskErrorEvent { error: format!("无法获取遮罩任务状态: {}", error) });
                        }
                    }
                }
                if let Some(state) = app.try_state::<crate::AppState>() {
                    let _ = state.mask_process.lock().map(|mut process| process.clear_if_pid(pid));
                }
            });
        }
        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), String> {
        if let Some(cancelled) = &self.cancelled {
            cancelled.store(true, Ordering::SeqCst);
        }
        if let Some(pid) = self.pid.take() {
            if let Some(job) = self.job.take() { job.terminate(); }
            #[cfg(target_os = "windows")]
            {
                let mut command = Command::new("taskkill");
                command.creation_flags(0x08000000);
                let _ = command.args(["/F", "/T", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
            #[cfg(not(target_os = "windows"))]
            { let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status(); }
        }
        self.cancelled = None;
        Ok(())
    }
}

fn is_current(app: &AppHandle, pid: u32) -> bool {
    app.try_state::<crate::AppState>()
        .and_then(|state| state.mask_process.lock().ok().map(|process| process.is_current_pid(pid)))
        .unwrap_or(false)
}
