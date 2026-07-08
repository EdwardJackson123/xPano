import argparse
import importlib.util
import os
import sys
import types
from pathlib import Path


def _configure_console_output():
    for stream in [sys.stdout, sys.stderr]:
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


def _safe_print(text):
    try:
        print(_localize_log_text(text), flush=True)
        return True
    except (BrokenPipeError, OSError):
        return False


def _localize_log_text(text):
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
    if stripped.startswith("WARN:"):
        return stripped.replace("WARN:", "警告：", 1)
    if stripped.startswith("ERROR:"):
        return stripped.replace("ERROR:", "错误：", 1)
    if stripped.startswith("DEBUG:"):
        return stripped.replace("DEBUG:", "调试：", 1)
    return text


class _StdoutLogger:
    def info(self, text):
        _safe_print(text)

    def warn(self, text):
        _safe_print(f"WARN: {text}")

    def error(self, text):
        _safe_print(f"ERROR: {text}")

    def debug(self, text):
        _safe_print(f"DEBUG: {text}")


def _install_lichtfeld_stub():
    module = types.ModuleType("lichtfeld")
    module.log = _StdoutLogger()
    module.ui = types.SimpleNamespace(set_panel_enabled=lambda *args, **kwargs: None)
    module.register_class = lambda *args, **kwargs: None
    module.unregister_class = lambda *args, **kwargs: None
    sys.modules.setdefault("lichtfeld", module)


def _load_plugin_densify(plugin_dir):
    plugin_dir = Path(plugin_dir).resolve()
    densify_path = plugin_dir / "densify.py"
    if not densify_path.exists():
        raise FileNotFoundError(densify_path)
    torch_home = Path("tools") / "torch-cache"
    torch_home.mkdir(parents=True, exist_ok=True)
    os.environ["TORCH_HOME"] = str(torch_home)
    roma_src = plugin_dir / "RoMaV2" / "src"
    for path in [plugin_dir, roma_src]:
        if path.exists() and str(path) not in sys.path:
            sys.path.insert(0, str(path))
    package_name = "_xpano_lichtfeld_densification_plugin"
    package = types.ModuleType(package_name)
    package.__path__ = [str(plugin_dir)]
    sys.modules[package_name] = package
    spec = importlib.util.spec_from_file_location(
        f"{package_name}.densify",
        densify_path,
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{package_name}.densify"] = module
    spec.loader.exec_module(module)
    return module


def main():
    _configure_console_output()
    parser = argparse.ArgumentParser(
        description="在 LichtFeld Studio 外运行 LichtFeld 致密化插件。",
        add_help=False,
    )
    parser.add_argument("--plugin-dir", required=True)
    args, plugin_args = parser.parse_known_args()

    _install_lichtfeld_stub()
    densify = _load_plugin_densify(args.plugin_dir)
    plugin_parser = densify.build_argparser()
    if not plugin_args or any(arg in {"-h", "--help"} for arg in plugin_args):
        plugin_parser.print_help()
        return 0

    def progress(percent, message):
        _safe_print(f"PROGRESS:{float(percent):.1f}:{_localize_progress_message(message)}")

    return densify.dense_init(plugin_parser.parse_args(plugin_args), progress_callback=progress)


def _localize_progress_message(message):
    mapping = {
        "Initializing RoMa v2 model...": "正在初始化 RoMa v2 模型...",
    }
    return mapping.get(str(message), str(message))


if __name__ == "__main__":
    raise SystemExit(main())
