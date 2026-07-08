use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Last emitted general log line — only emit when content actually changes.
static LAST_LOG_LINE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
use tauri::{AppHandle, Emitter, Manager};

use crate::process_job::ProcessJob;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressEvent {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    pub percent: f64,
    pub message: String,
    pub elapsed: u64,
    pub phase_percents: PhasePercents,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhasePercents {
    pub extract: f64,
    pub align: f64,
    pub export: f64,
}

#[derive(Deserialize)]
struct StructuredPipelineEvent {
    phase: Option<String>,
    stage: Option<String>,
    percent: Option<f64>,
    #[serde(default, alias = "phasePercent")]
    phase_percent: Option<f64>,
    #[serde(default, alias = "phasePercents")]
    phase_percents: Option<PhasePercents>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCompleteEvent {
    pub output_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineErrorEvent {
    pub error: String,
}

pub struct PipelineState {
    pid: Option<u32>,
    cancelled: Option<Arc<AtomicBool>>,
    job: Option<ProcessJob>,
}

const PROGRESS_EXTRACT_START: f64 = 4.0;
const PROGRESS_EXTRACT_END: f64 = 30.0;
const PROGRESS_ALIGN_END: f64 = 86.0;
const PROGRESS_EXPORT_END: f64 = 100.0;

fn phase_for_progress(pct: f64) -> &'static str {
    if pct < PROGRESS_EXTRACT_END {
        "extract"
    } else if pct < PROGRESS_ALIGN_END {
        "align"
    } else {
        "export"
    }
}

fn phase_percents(pct: f64) -> PhasePercents {
    let extract = if pct <= PROGRESS_EXTRACT_START {
        0.0
    } else {
        ((pct - PROGRESS_EXTRACT_START)
            / (PROGRESS_EXTRACT_END - PROGRESS_EXTRACT_START)
            * 100.0)
            .clamp(0.0, 100.0)
    };
    let align = if pct <= PROGRESS_EXTRACT_END {
        0.0
    } else {
        ((pct - PROGRESS_EXTRACT_END) / (PROGRESS_ALIGN_END - PROGRESS_EXTRACT_END) * 100.0)
            .clamp(0.0, 100.0)
    };
    let export = if pct <= PROGRESS_ALIGN_END {
        0.0
    } else {
        ((pct - PROGRESS_ALIGN_END) / (PROGRESS_EXPORT_END - PROGRESS_ALIGN_END) * 100.0)
            .clamp(0.0, 100.0)
    };
    PhasePercents {
        extract,
        align,
        export,
    }
}

fn phase_percent_from_overall(phase: &str, percent: f64) -> f64 {
    match phase {
        "extract" => ((percent - PROGRESS_EXTRACT_START)
            / (PROGRESS_EXTRACT_END - PROGRESS_EXTRACT_START)
            * 100.0)
            .clamp(0.0, 100.0),
        "align" => ((percent - PROGRESS_EXTRACT_END)
            / (PROGRESS_ALIGN_END - PROGRESS_EXTRACT_END)
            * 100.0)
            .clamp(0.0, 100.0),
        "export" => ((percent - PROGRESS_ALIGN_END)
            / (PROGRESS_EXPORT_END - PROGRESS_ALIGN_END)
            * 100.0)
            .clamp(0.0, 100.0),
        "complete" => 100.0,
        _ => 0.0,
    }
}

fn phase_percents_for_structured(phase: &str, phase_percent: f64, percent: f64) -> PhasePercents {
    let value = phase_percent.clamp(0.0, 100.0);
    match phase {
        "extract" => PhasePercents {
            extract: value,
            align: 0.0,
            export: 0.0,
        },
        "align" => PhasePercents {
            extract: 100.0,
            align: value,
            export: 0.0,
        },
        "export" => PhasePercents {
            extract: 100.0,
            align: 100.0,
            export: value,
        },
        "complete" => PhasePercents {
            extract: 100.0,
            align: 100.0,
            export: 100.0,
        },
        _ => phase_percents(percent),
    }
}

fn structured_progress_event(raw: &str, elapsed: u64) -> Option<PipelineProgressEvent> {
    let payload: StructuredPipelineEvent = serde_json::from_str(raw).ok()?;
    let percent = payload.percent.unwrap_or(0.0).clamp(0.0, 100.0);
    let phase = payload
        .phase
        .unwrap_or_else(|| phase_for_progress(percent).to_string());
    let phase_percent = payload
        .phase_percent
        .unwrap_or_else(|| phase_percent_from_overall(&phase, percent));
    let phase_percents = payload
        .phase_percents
        .unwrap_or_else(|| phase_percents_for_structured(&phase, phase_percent, percent));
    let message = payload
        .message
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("{} {:.0}%", phase, percent));

    Some(PipelineProgressEvent {
        phase,
        stage: payload.stage,
        percent,
        message,
        elapsed,
        phase_percents,
    })
}

fn is_current_pipeline(app: &AppHandle, pid: u32) -> bool {
    app.try_state::<crate::AppState>()
        .and_then(|state| state.pipeline.lock().ok().map(|p| p.is_current_pid(pid)))
        .unwrap_or(false)
}

impl PipelineState {
    pub fn new() -> Self {
        Self {
            pid: None,
            cancelled: None,
            job: None,
        }
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        python_exe: &str,
        script: &str,
        args: &[String],
    ) -> Result<(), String> {
        // Kill any previous pipeline before starting a new one
        let _ = self.cancel();

        let python = crate::tool_resolver::resolve_python(python_exe);
        let script_path = crate::tool_resolver::resolve_script_path(script);
        let ffmpeg = crate::tool_resolver::locate_ffmpeg();
        let ffprobe = crate::tool_resolver::locate_ffprobe();

        let mut cmd = Command::new(&python);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Some(root) = script_path.parent().and_then(|path| path.parent()) {
            cmd.env("PYTHONPATH", root);
        }
        cmd.env("XPANO_FFMPEG", &ffmpeg);
        cmd.env("XPANO_FFPROBE", &ffprobe);
        if let Some(ffmpeg_dir) = std::path::Path::new(&ffmpeg).parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let separator = if cfg!(windows) { ";" } else { ":" };
            cmd.env(
                "PATH",
                format!(
                    "{}{}{}",
                    ffmpeg_dir.to_string_lossy(),
                    separator,
                    current_path
                ),
            );
        }
        cmd.arg(script_path.to_str().unwrap_or(script));
        for arg in args {
            cmd.arg(arg);
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("启动失败: {}", e))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;

        let cancelled = Arc::new(AtomicBool::new(false));
        self.pid = Some(pid);
        self.cancelled = Some(cancelled.clone());
        self.job = match ProcessJob::new().and_then(|job| {
            job.assign_pid(pid)?;
            Ok(job)
        }) {
            Ok(job) => Some(job),
            Err(error) => {
                let _ = app.emit(
                    "pipeline:progress",
                    PipelineProgressEvent {
                        phase: String::new(),
                        stage: None,
                        percent: 0.0,
                        message: format!("WARN: {}", error),
                        elapsed: 0,
                        phase_percents: PhasePercents {
                            extract: 0.0,
                            align: 0.0,
                            export: 0.0,
                        },
                    },
                );
                None
            }
        };

        let output_path = args
            .windows(2)
            .find_map(|pair| {
                if pair[0] == "--output" {
                    Some(pair[1].clone())
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let start_time = Arc::new(Mutex::new(std::time::Instant::now()));

        // Spawn stdout reader
        {
            let app = app.clone();
            let start = start_time.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(text) = line else { break };
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if !is_current_pipeline(&app, pid) {
                        break;
                    }

                    if let Some(payload) = trimmed.strip_prefix("PIPELINE_EVENT:") {
                        if let Some(event) = structured_progress_event(
                            payload.trim(),
                            start.lock().unwrap().elapsed().as_secs(),
                        ) {
                            let _ = app.emit("pipeline:progress", event);
                        }
                        continue;
                    }

                    // PROGRESS:N format
                    if let Some(val) = trimmed.strip_prefix("PROGRESS:") {
                        if let Ok(pct) = val.trim().parse::<f64>() {
                            let elapsed = start.lock().unwrap().elapsed().as_secs();
                            let event = PipelineProgressEvent {
                                phase: phase_for_progress(pct).to_string(),
                                stage: None,
                                percent: pct,
                                message: format!("进度 {}%", pct as i32),
                                elapsed,
                                phase_percents: phase_percents(pct),
                            };
                            let _ = app.emit("pipeline:progress", event);
                        }
                        continue;
                    }

                    // PREVIEW:left|right format
                    if let Some(payload) = trimmed.strip_prefix("PREVIEW:") {
                        if let Some((left, right)) = payload.split_once('|') {
                            let _ = app.emit(
                                "pipeline:preview",
                                serde_json::json!({
                                    "left": left.trim(), "right": right.trim()
                                }),
                            );
                        }
                        continue;
                    }

                    // ERROR: prefix
                    if let Some(err) = trimmed.strip_prefix("ERROR:") {
                        let _ = app.emit(
                            "pipeline:error",
                            PipelineErrorEvent {
                                error: err.trim().to_string(),
                            },
                        );
                        continue;
                    }

                    // General log line — only emit when content changes
                    {
                        let mut last = LAST_LOG_LINE.lock().unwrap();
                        let msg = trimmed.to_string();
                        if last.as_ref() == Some(&msg) {
                            continue;
                        }
                        *last = Some(msg.clone());
                        let _ = app.emit(
                            "pipeline:progress",
                            PipelineProgressEvent {
                                phase: String::new(),
                                stage: None,
                                percent: 0.0,
                                message: msg,
                                elapsed: start.lock().unwrap().elapsed().as_secs(),
                                phase_percents: PhasePercents {
                                    extract: 0.0,
                                    align: 0.0,
                                    export: 0.0,
                                },
                            },
                        );
                    }
                }
            });
        }

        // Spawn stderr reader (prevents pipe deadlock, reports errors)
        {
            let app = app.clone();
            let start = start_time.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for text in reader.lines().map_while(Result::ok) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        if !is_current_pipeline(&app, pid) {
                            break;
                        }
                        if let Some(err) = trimmed.strip_prefix("ERROR:") {
                            let _ = app.emit(
                                "pipeline:error",
                                PipelineErrorEvent {
                                    error: err.trim().to_string(),
                                },
                            );
                        } else {
                            let _ = app.emit(
                                "pipeline:progress",
                                PipelineProgressEvent {
                                    phase: String::new(),
                                    stage: None,
                                    percent: 0.0,
                                    message: trimmed.to_string(),
                                    elapsed: start.lock().unwrap().elapsed().as_secs(),
                                    phase_percents: PhasePercents {
                                        extract: 0.0,
                                        align: 0.0,
                                        export: 0.0,
                                    },
                                },
                            );
                        }
                    }
                }
            });
        }

        // A process is complete only when the child exits successfully.  Closing
        // stdout also happens on cancellation and crashes, so readers never emit
        // `pipeline:complete`.
        {
            let app = app.clone();
            let cancelled = cancelled.clone();
            std::thread::spawn(move || {
                let status = child.wait();
                let was_cancelled = cancelled.load(Ordering::SeqCst);

                let is_current = is_current_pipeline(&app, pid);

                if is_current {
                    match status {
                        Ok(_exit) if was_cancelled => {
                            let _ = app.emit(
                                "pipeline:error",
                                PipelineErrorEvent {
                                    error: "任务已取消".to_string(),
                                },
                            );
                        }
                        Ok(exit) if exit.success() => {
                            let _ = app
                                .emit("pipeline:complete", PipelineCompleteEvent { output_path });
                        }
                        Ok(exit) => {
                            let code = exit
                                .code()
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "unknown".to_string());
                            let _ = app.emit(
                                "pipeline:error",
                                PipelineErrorEvent {
                                    error: format!("任务异常结束，退出码 {}", code),
                                },
                            );
                        }
                        Err(error) => {
                            let _ = app.emit(
                                "pipeline:error",
                                PipelineErrorEvent {
                                    error: format!("无法获取任务退出状态: {}", error),
                                },
                            );
                        }
                    }
                }

                if let Some(state) = app.try_state::<crate::AppState>() {
                    let _ = state.pipeline.lock().map(|mut p| p.clear_if_pid(pid));
                }
            });
        }

        Ok(())
    }

    /// Release the recorded process metadata after the watcher thread has
    /// observed the process exit.
    pub fn clear(&mut self) {
        self.pid = None;
        self.cancelled = None;
        self.job = None;
    }

    pub fn clear_if_pid(&mut self, pid: u32) {
        if self.pid == Some(pid) {
            self.clear();
        }
    }

    pub fn is_current_pid(&self, pid: u32) -> bool {
        self.pid == Some(pid)
    }

    pub fn cancel(&mut self) -> Result<(), String> {
        if let Some(cancelled) = &self.cancelled {
            cancelled.store(true, Ordering::SeqCst);
        }

        if let Some(pid) = self.pid.take() {
            if let Some(job) = self.job.take() {
                job.terminate();
            }

            // On Windows, kill the entire process tree so subprocesses
            // (Metashape / COLMAP commands) don't become orphans.
            #[cfg(target_os = "windows")]
            {
                let mut cmd = std::process::Command::new("taskkill");
                cmd.creation_flags(0x08000000);
                let _ = cmd
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        self.cancelled = None;
        Ok(())
    }
}
