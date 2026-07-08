param(
    [string]$PluginUrl = "https://github.com/shadygm/Lichtfeld-Densification-Plugin.git",
    [string]$PluginRef = "main",
    [string]$Python = "python",
    [string]$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple",
    [string]$PipTrustedHost = "pypi.tuna.tsinghua.edu.cn",
    [string]$Root = $null,
    [switch]$UseCudaTorch,
    [switch]$SkipDeps
)

$ErrorActionPreference = "Stop"

function Convert-ToPlainFileSystemPath {
    param([Parameter(Mandatory=$true)][object]$Path)
    $text = [string]$Path
    $text = $text.Replace("Microsoft.PowerShell.Core\FileSystem::", "")
    $text = $text.Replace("FileSystem::", "")
    if ([System.IO.Path]::IsPathRooted($text)) {
        return [System.IO.Path]::GetFullPath($text)
    }
    $cwd = (Get-Location).ProviderPath
    return [System.IO.Path]::GetFullPath((Join-Path $cwd $text))
}

if (-not $Root) {
    $Root = Join-Path $PSScriptRoot ".."
}
$Root = Convert-ToPlainFileSystemPath $Root
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$Root = Convert-ToPlainFileSystemPath (Resolve-Path -LiteralPath $Root)
$Tools = Join-Path $Root "tools"
$PluginDir = Join-Path $Tools "lichtfeld-densification-plugin"
$VenvDir = Join-Path $Root ".venv-densify"

New-Item -ItemType Directory -Force -Path $Tools | Out-Null

function Get-VenvPython {
    param([Parameter(Mandatory=$true)][string]$VenvPath)
    $candidates = @(
        (Join-Path $VenvPath "Scripts\python.exe"),
        (Join-Path $VenvPath "bin\python.exe"),
        (Join-Path $VenvPath "bin\python")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    return $candidates[0]
}

function Test-CompatiblePython {
    param(
        [Parameter(Mandatory=$true)][string]$Executable,
        [string[]]$Arguments = @()
    )
    try {
        $code = @"
import importlib.util
import sys
import sysconfig
if sys.version_info[:2] != (3, 12):
    raise SystemExit(4)
platform = sysconfig.get_platform().lower()
if 'mingw' in platform or 'msys' in platform:
    raise SystemExit(2)
if importlib.util.find_spec('venv') is None:
    raise SystemExit(3)
print(platform)
"@
        & $Executable @Arguments -c $code | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Find-CompatiblePython {
    param([string]$Preferred)
    $candidates = @()
    if ($Preferred) {
        $candidates += @{ Exe = $Preferred; Args = @() }
    }
    $candidates += @(
        @{ Exe = "py"; Args = @("-3.12") },
        @{ Exe = "py"; Args = @("-3") },
        @{ Exe = "python"; Args = @() },
        @{ Exe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"; Args = @() },
        @{ Exe = "$env:ProgramFiles\Python312\python.exe"; Args = @() }
    )

    foreach ($candidate in $candidates) {
        $exe = [string]$candidate.Exe
        $args = @($candidate.Args)
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue) -and -not (Test-Path $exe)) {
            continue
        }
        if (Test-CompatiblePython -Executable $exe -Arguments $args) {
            $resolved = & $exe @args -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $resolved) {
                return ($resolved | Select-Object -First 1)
            }
            return $exe
        }
    }
    return ""
}

function Invoke-GitChecked {
    param([Parameter(Mandatory=$true)][string[]]$GitArgs)
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & git @GitArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Git failed with exit code $LASTEXITCODE`: git $($GitArgs -join ' ')"
        }
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

function Get-PipIndexArgs {
    param([string]$IndexUrl = $PipIndex, [string]$TrustedHost = $PipTrustedHost)
    $args = @("--disable-pip-version-check", "--no-input", "--progress-bar", "off", "--timeout", "120")
    if ($IndexUrl) {
        $args += @("-i", $IndexUrl)
    }
    if ($TrustedHost) {
        $args += @("--trusted-host", $TrustedHost)
    }
    return $args
}

function Get-GitHubArchiveUrls {
    param(
        [Parameter(Mandatory=$true)][string]$RepoUrl,
        [Parameter(Mandatory=$true)][string]$Ref
    )
    $base = $RepoUrl.Trim()
    if ($base.EndsWith(".git")) {
        $base = $base.Substring(0, $base.Length - 4)
    }
    $archive = "$base/archive/refs/heads/$Ref.zip"
    return @(
        "https://gh-proxy.com/$archive",
        "https://hub.gitmirror.com/$archive",
        "https://gh.llkk.cc/$archive",
        $archive
    )
}

function Install-PluginFromArchive {
    param(
        [Parameter(Mandatory=$true)][string]$RepoUrl,
        [Parameter(Mandatory=$true)][string]$Ref,
        [Parameter(Mandatory=$true)][string]$Destination
    )

    $zipPath = Join-Path $env:TEMP "lichtfeld-densification-plugin-$Ref.zip"
    $extractDir = Join-Path $env:TEMP "lichtfeld-densification-plugin-$Ref"
    $errors = @()

    foreach ($url in (Get-GitHubArchiveUrls -RepoUrl $RepoUrl -Ref $Ref)) {
        try {
            Write-Host "正在下载 LichtFeld 致密化插件压缩包：$url"
            Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
            Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
            Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
            $source = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
            if (-not $source) {
                throw "插件压缩包中未找到源码目录。"
            }
            if (Test-Path $Destination) {
                Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
            }
            New-Item -ItemType Directory -Force -Path (Split-Path $Destination -Parent) | Out-Null
            Move-Item -Path $source.FullName -Destination $Destination -Force
            Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
            Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
            if (-not (Test-Path (Join-Path $Destination "densify.py"))) {
                throw "下载的插件缺少 densify.py。"
            }
            return $true
        } catch {
            $errors += "$url => $($_.Exception.Message)"
            Write-Host "当前插件下载源失败，正在尝试下一个源..."
        }
    }

    Write-Host "插件压缩包下载全部失败：$($errors -join ' | ')"
    return $false
}

# ------------------------------------------------------------------
# Download/update the densification plugin. Prefer archive downloads through
# China-friendly GitHub proxies so a clean workstation does not require git.
# ------------------------------------------------------------------
if (-not (Test-Path (Join-Path $PluginDir "densify.py"))) {
    if (Install-PluginFromArchive -RepoUrl $PluginUrl -Ref $PluginRef -Destination $PluginDir) {
        Write-Host "致密化插件已就绪：$PluginDir"
    } elseif (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Host "正在通过 Git 下载 LichtFeld 致密化插件..."
        Invoke-GitChecked -GitArgs @("clone", "--quiet", "--depth", "1", "--branch", $PluginRef, $PluginUrl, $PluginDir)
    } else {
        throw "无法下载 LichtFeld 致密化插件，请检查网络连接，或安装 Git 后重试。"
    }
} else {
    if ((Test-Path (Join-Path $PluginDir ".git")) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        Push-Location $PluginDir
        Write-Host "正在更新 LichtFeld 致密化插件..."
        try {
            Invoke-GitChecked -GitArgs @("fetch", "--quiet", "--depth", "1", "origin", $PluginRef)
            Invoke-GitChecked -GitArgs @("-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD")
        } catch {
            Write-Host "插件更新失败，将继续使用现有插件：$($_.Exception.Message)"
        }
        Pop-Location
    } else {
        Write-Host "插件已存在，跳过更新。"
    }
}

if ($SkipDeps) {
    Write-Host "插件目录：$PluginDir"
    Write-Host "已跳过依赖安装。"
    exit 0
}

# ------------------------------------------------------------------
# Detect or auto-install standard CPython (Huawei mirror for fast CN download)
# ------------------------------------------------------------------
$pythonCmd = Find-CompatiblePython $Python
if (-not $pythonCmd) {
    Write-Host "未找到可用的 CPython 3.12 + venv，正在自动安装..."
    $pythonVersion = "3.12.4"
    $pythonUrl = "https://repo.huaweicloud.com/python/$pythonVersion/python-$pythonVersion-amd64.exe"
    $installer = "$env:TEMP\python-$pythonVersion-installer.exe"

    Write-Host "正在下载 Python：$pythonUrl"
    Invoke-WebRequest -Uri $pythonUrl -OutFile $installer -UseBasicParsing

    Write-Host "正在静默安装 Python，可能需要一两分钟..."
    Start-Process -Wait -FilePath $installer -ArgumentList "/quiet InstallAllUsers=0 Include_launcher=0 Include_pip=1 Include_test=0 PrependPath=1"
    Remove-Item $installer -Force

    # Refresh PATH so the newly installed python is visible
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")

    $pythonCmd = Find-CompatiblePython ""
    if (-not $pythonCmd) {
        Write-Host "错误：Python 安装失败，请从 https://www.python.org/ 手动安装标准 CPython。"
        exit 1
    }
}
Write-Host "Python 已就绪：$pythonCmd"

# ------------------------------------------------------------------
# Create virtual environment
# ------------------------------------------------------------------
$ExistingVenvPython = Get-VenvPython $VenvDir
if ((Test-Path $ExistingVenvPython) -and -not (Test-CompatiblePython -Executable $ExistingVenvPython)) {
    Write-Host "现有虚拟环境 Python 不兼容，正在重建虚拟环境..."
    Remove-Item -Recurse -Force $VenvDir -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Get-VenvPython $VenvDir))) {
    & $pythonCmd -m venv $VenvDir
    Write-Host "已创建虚拟环境：$VenvDir"
}

$VenvPython = Get-VenvPython $VenvDir
if (-not (Test-Path $VenvPython)) {
    throw "虚拟环境 Python 创建失败：$VenvPython"
}
Write-Host "使用虚拟环境 Python：$VenvPython"

function Invoke-Checked {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Command,
        [string[]]$CommandArgs
    )
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $Command @CommandArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        $tail = ($output | Select-Object -Last 8) -join "`n"
        throw "Command failed with exit code $exitCode`: $Command $($CommandArgs -join ' ')`n$tail"
    }
    $output | ForEach-Object { Write-Host $_ }
}

function Invoke-CheckedQuiet {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Command,
        [string[]]$CommandArgs
    )
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $Command @CommandArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        $tail = ($output | Select-Object -Last 8) -join "`n"
        throw "Command failed with exit code $exitCode`: $Command $($CommandArgs -join ' ')`n$tail"
    }
}

function Invoke-AnyChecked {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Command,
        [Parameter(Mandatory=$true)]
        [object[]]$Attempts
    )

    $errors = @()
    foreach ($attempt in $Attempts) {
        $attemptArgs = @($attempt)
        $previousErrorAction = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $output = & $Command @attemptArgs 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($exitCode -eq 0) {
            $output | ForEach-Object { Write-Host $_ }
            return $true
        }
        $tail = ($output | Select-Object -Last 4) -join " "
        $errors += "exit $exitCode`: $Command $($attemptArgs -join ' '); $tail"
        if ($Attempts.Count -gt 1) {
            Write-Host "当前源未提供兼容的 wheel，正在尝试备用源..."
        }
    }
    if ($Attempts.Count -le 1) {
        throw "安装失败：$($errors -join ' | ')"
    }
    throw "所有安装源均失败：$($errors -join ' | ')"
}

Write-Host "正在检查 pip 基础工具..."
$pipToolArgs = @("-m", "pip", "--disable-pip-version-check", "--version")
Invoke-CheckedQuiet $VenvPython $pipToolArgs

if ($UseCudaTorch) {
    Write-Host "正在安装 CUDA 版 PyTorch cu128..."
    Write-Host "将使用 PyTorch 官方 cu128 wheel 源；如果失败，请检查是否能访问 download.pytorch.org，或在高级参数中关闭 CUDA。"
    $cudaTorchAttempts = @(
        ,@(
            "-m", "pip", "install",
            "--index-url", "https://download.pytorch.org/whl/cu128",
            "--trusted-host", "download.pytorch.org",
            "--disable-pip-version-check",
            "--no-input",
            "--progress-bar", "off",
            "--timeout", "120",
            "torch==2.8.0+cu128",
            "torchvision==0.23.0+cu128"
        )
    )
    Invoke-AnyChecked -Command $VenvPython -Attempts $cudaTorchAttempts | Out-Null
} else {
    Write-Host "正在安装 CPU 版 PyTorch..."
    $cpuTorchAttempts = @(
        ,(@("-m", "pip", "install", "torch==2.8.0", "torchvision==0.23.0") + (Get-PipIndexArgs -IndexUrl "https://pypi.tuna.tsinghua.edu.cn/simple" -TrustedHost "pypi.tuna.tsinghua.edu.cn")),
        ,(@("-m", "pip", "install", "torch==2.8.0", "torchvision==0.23.0") + (Get-PipIndexArgs -IndexUrl "https://mirrors.aliyun.com/pypi/simple/" -TrustedHost "mirrors.aliyun.com")),
        ,@(
            "-m", "pip", "install",
            "--disable-pip-version-check",
            "--no-input",
            "--progress-bar", "off",
            "--timeout", "120",
            "torch==2.8.0",
            "torchvision==0.23.0"
        )
    )
    Invoke-AnyChecked -Command $VenvPython -Attempts $cpuTorchAttempts | Out-Null
}

Write-Host "正在安装 LichtFeld 致密化依赖..."
$lfsPackages = @(
    "numpy",
    "pycolmap==4.0.4",
    "Pillow",
    "scipy",
    "tqdm",
    "einops>=0.8.1",
    "rich>=14.2.0",
    "open3d"
)
$lfsDependencyAttempts = @(
    ,(@("-m", "pip", "install") + $lfsPackages + (Get-PipIndexArgs -IndexUrl "https://pypi.tuna.tsinghua.edu.cn/simple" -TrustedHost "pypi.tuna.tsinghua.edu.cn")),
    ,(@("-m", "pip", "install") + $lfsPackages + (Get-PipIndexArgs -IndexUrl "https://mirrors.aliyun.com/pypi/simple/" -TrustedHost "mirrors.aliyun.com")),
    ,(@("-m", "pip", "install") + $lfsPackages + @("--disable-pip-version-check", "--no-input", "--progress-bar", "off", "--timeout", "120"))
)
Invoke-AnyChecked -Command $VenvPython -Attempts $lfsDependencyAttempts | Out-Null

Write-Host "正在验证 LichtFeld 致密化环境..."
$verifyCode = @"
import importlib.util
import pathlib
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
plugin = pathlib.Path(r'''$PluginDir''')
runner = pathlib.Path(r'''$PSScriptRoot''') / 'run_lichtfeld_densify_standalone.py'
required = ['torch', 'torchvision', 'numpy', 'pycolmap', 'PIL', 'scipy', 'tqdm', 'einops', 'rich', 'open3d']
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit('缺少 Python 模块：' + ', '.join(missing))
if not (plugin / 'densify.py').exists():
    raise SystemExit('缺少 LichtFeld densify.py：' + str(plugin / 'densify.py'))
result = subprocess.run(
    [sys.executable, str(runner), '--plugin-dir', str(plugin), '--help'],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    encoding='utf-8',
    errors='replace',
)
if result.returncode != 0:
    print(result.stdout[-3000:].encode('ascii', 'backslashreplace').decode('ascii'))
    raise SystemExit(result.returncode)
if '--scene_root' not in result.stdout or '--roma_setting' not in result.stdout:
    print(result.stdout[-3000:].encode('ascii', 'backslashreplace').decode('ascii'))
    raise SystemExit('运行器未暴露预期的 LichtFeld 参数。')
print('验证通过')
"@
Invoke-Checked $VenvPython @("-c", $verifyCode)

Write-Host ""
Write-Host "=== 配置完成 ==="
Write-Host "插件目录：$PluginDir"
Write-Host "Python 环境：$VenvPython"
