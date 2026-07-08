from dataclasses import dataclass
from pathlib import Path
import subprocess
import sys

from scripts.process_guard import cleanup_process_tree, guard_process, popen_creationflags
from scripts.runtime_paths import app_root, candidate_roots, first_existing


@dataclass(frozen=True)
class LichtfeldDensifyConfig:
    python_exe: str = sys.executable
    plugin_dir: Path = None
    scene_root: Path = None
    images_subdir: str = "images"
    out_name: str = "points3D_dense.ply"
    roma_setting: str = "fast"
    num_refs: float = 0.75
    nns_per_ref: int = 4
    matches_per_ref: int = 12000
    certainty_thresh: float = 0.20
    reproj_thresh: float = 1.5
    sampson_thresh: float = 5.0
    min_parallax_deg: float = 0.5
    max_points: int = 0
    seed: int = 0
    no_filter: bool = False
    publish_to_points3d: bool = True


def _project_root():
    return app_root()


def _normal_windows_path(path):
    text = str(path)
    if text.startswith("\\\\?\\UNC\\"):
        return "\\\\" + text[8:]
    if text.startswith("\\\\?\\"):
        return text[4:]
    return text


def locate_densify_python(project_root=None):
    roots = [Path(project_root)] if project_root else candidate_roots()
    candidates = []
    for root in roots:
        candidates.extend([
            root / ".venv-densify" / "Scripts" / "python.exe",
            root / ".venv-densify" / "bin" / "python.exe",
            root / ".venv-densify" / "bin" / "python",
        ])
    fallback_root = roots[0]
    candidates.extend([
        fallback_root / ".venv-densify" / "Scripts" / "python.exe",
        fallback_root / ".venv-densify" / "bin" / "python.exe",
        fallback_root / ".venv-densify" / "bin" / "python",
    ]
    )
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return str(candidates[0])


def locate_densify_plugin(project_root=None):
    roots = [Path(project_root)] if project_root else candidate_roots()
    candidates = []
    for root in roots:
        candidates.extend([
            root / "tools" / "lichtfeld-densification-plugin",
            root / "third_party" / "lichtfeld-densification-plugin",
        ])
    for candidate in candidates:
        if (candidate / "densify.py").exists():
            return candidate
    return candidates[0]


def _append_arg(command, name, value):
    command.extend([name, str(value)])


def _append_positive_int_arg(command, name, value):
    value = int(value)
    if value < 0:
        raise ValueError(f"{name} must be greater than or equal to 0")
    command.extend([name, str(value)])


def build_densify_command(config):
    if not config.scene_root:
        raise ValueError("缺少 LichtFeld 致密化场景目录 scene_root")
    plugin_dir = Path(config.plugin_dir) if config.plugin_dir else locate_densify_plugin()
    script = first_existing([
        *(root / "scripts" / "run_lichtfeld_densify_standalone.py" for root in candidate_roots()),
    ])
    if not script:
        raise FileNotFoundError("未找到 LichtFeld 致密化运行脚本 run_lichtfeld_densify_standalone.py")
    command = [config.python_exe or locate_densify_python(), str(script), "--plugin-dir", str(plugin_dir)]
    _append_arg(command, "--scene_root", Path(config.scene_root))
    _append_arg(command, "--images_subdir", config.images_subdir)
    _append_arg(command, "--out_name", config.out_name)
    _append_arg(command, "--roma_setting", config.roma_setting)
    _append_arg(command, "--num_refs", _plugin_num_refs(config.num_refs))
    _append_positive_int_arg(command, "--nns_per_ref", config.nns_per_ref)
    _append_positive_int_arg(command, "--matches_per_ref", config.matches_per_ref)
    _append_arg(command, "--certainty_thresh", config.certainty_thresh)
    _append_arg(command, "--reproj_thresh", config.reproj_thresh)
    _append_arg(command, "--sampson_thresh", config.sampson_thresh)
    _append_arg(command, "--min_parallax_deg", config.min_parallax_deg)
    _append_positive_int_arg(command, "--max_points", config.max_points)
    _append_arg(command, "--seed", config.seed)
    if config.no_filter:
        command.append("--no_filter")
    return command


def _plugin_num_refs(value):
    value = float(value)
    if value == 1.0:
        return 1.01
    return value


def _run_command_streaming(command, cwd, log_cb):
    proc = subprocess.Popen(
        command,
        cwd=_normal_windows_path(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=popen_creationflags(),
    )
    job = guard_process(proc)
    try:
        output_lines = []
        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if line:
                output_lines.append(line)
                log_cb(line)
        rc = proc.wait()
        return subprocess.CompletedProcess(command, rc, stdout="\n".join(output_lines), stderr="")
    finally:
        cleanup_process_tree(proc, job)


def run_densify_command(config, progress_cb=None, log_cb=None, runner=None):
    progress_cb = progress_cb or (lambda value: None)
    log_cb = log_cb or (lambda text: None)

    command = build_densify_command(config)
    plugin_dir = Path(config.plugin_dir) if config.plugin_dir else locate_densify_plugin()
    log_cb(f"启动 LichtFeld 致密化命令：{' '.join(str(part) for part in command)}")
    progress_cb(5)
    work_dir = _project_root()
    if runner is None:
        result = _run_command_streaming(command, work_dir, log_cb)
    else:
        result = runner(
            command,
            cwd=_normal_windows_path(work_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        for stream in [getattr(result, "stdout", ""), getattr(result, "stderr", "")]:
            for line in (stream or "").splitlines():
                if line:
                    log_cb(line)
    if getattr(result, "returncode", 0) != 0:
        raise RuntimeError(f"LichtFeld 致密化失败，退出码 {result.returncode}")
    progress_cb(100)
    return command
