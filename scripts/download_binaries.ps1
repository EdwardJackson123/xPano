param(
    [string]$OutputDir = $null,
    [switch]$SkipFfmpeg,
    [switch]$SkipPython,
    [switch]$SkipPythonPackages
)

$ErrorActionPreference = "Stop"

if (-not $OutputDir) {
    $OutputDir = Join-Path (Split-Path $PSScriptRoot -Parent) "xpano-ui\binaries"
}

Write-Host "Output: $OutputDir"

# ------------------------------------------------------------------
# FFmpeg essentials build (static, no DLL dependencies) — ~30 MB
# ------------------------------------------------------------------
if (-not $SkipFfmpeg) {
    $ffmpegDir = Join-Path $OutputDir "ffmpeg"
    $ffmpegExe = Join-Path $ffmpegDir "ffmpeg.exe"

    if (-not (Test-Path $ffmpegExe)) {
        Write-Host "Downloading FFmpeg essentials..."
        New-Item -ItemType Directory -Force -Path $ffmpegDir | Out-Null

        $ffmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        $ffmpegZip = "$env:TEMP\ffmpeg-essentials.zip"
        $ffmpegExtract = "$env:TEMP\ffmpeg-extract"

        Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing

        Write-Host "Extracting FFmpeg..."
        Remove-Item -Recurse -Force $ffmpegExtract -ErrorAction SilentlyContinue
        Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegExtract -Force

        $extractedBin = Get-ChildItem -Path $ffmpegExtract -Directory | Select-Object -First 1
        $extractedBinDir = Join-Path $extractedBin.FullName "bin"

        Copy-Item -Path (Join-Path $extractedBinDir "ffmpeg.exe") -Destination $ffmpegDir
        Copy-Item -Path (Join-Path $extractedBinDir "ffprobe.exe") -Destination $ffmpegDir

        Remove-Item -Recurse -Force $ffmpegExtract
        Remove-Item -Force $ffmpegZip

        Write-Host "FFmpeg ready: $ffmpegDir"
    } else {
        Write-Host "FFmpeg already present, skipping."
    }
}

# ------------------------------------------------------------------
# Python embedded distribution — ~35 MB extracted
# ------------------------------------------------------------------
if (-not $SkipPython) {
    $pythonDir = Join-Path $OutputDir "python"
    $pythonExe = Join-Path $pythonDir "python.exe"

    if (-not (Test-Path $pythonExe)) {
        Write-Host "Downloading Python embedded..."
        New-Item -ItemType Directory -Force -Path $pythonDir | Out-Null

        $pythonUrl = "https://www.python.org/ftp/python/3.12.4/python-3.12.4-embed-amd64.zip"
        $pythonZip = "$env:TEMP\python-embed.zip"

        Invoke-WebRequest -Uri $pythonUrl -OutFile $pythonZip -UseBasicParsing

        Write-Host "Extracting Python..."
        Expand-Archive -Path $pythonZip -DestinationPath $pythonDir -Force
        Remove-Item -Force $pythonZip

        Write-Host "Python ready: $pythonDir"
    } else {
        Write-Host "Python already present, skipping."
    }

    # Enable bundled site-packages before import site. Embedded Python's ._pth
    # isolation is useful, but plain "import site" can otherwise pull packages
    # from the user's roaming Python directory before our bundled wheels.
    $pth = Join-Path $pythonDir "python312._pth"
    if (Test-Path $pth) {
        $lines = New-Object System.Collections.Generic.List[string]
        $hasSitePackages = $false
        $hasImportSite = $false
        foreach ($line in Get-Content $pth) {
            if ($line.Trim() -eq "Lib/site-packages") {
                $hasSitePackages = $true
                continue
            }
            if ($line.Trim() -eq "import site") {
                if (-not $hasSitePackages) {
                    $lines.Add("Lib/site-packages")
                    $hasSitePackages = $true
                }
                $hasImportSite = $true
            }
            $lines.Add($line)
        }
        if (-not $hasSitePackages) { $lines.Add("Lib/site-packages") }
        if (-not $hasImportSite) { $lines.Add(""); $lines.Add("import site") }
        Set-Content -Path $pth -Value $lines -Encoding ascii
        Write-Host "Patched python312._pth: bundled site-packages first"
    }

    $sitePackages = Join-Path $pythonDir "Lib\site-packages"
    New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
    $siteCustomize = Join-Path $sitePackages "sitecustomize.py"
    @'
import site
import sys
from pathlib import Path

user_site = getattr(site, "USER_SITE", None)
user_base = getattr(site, "USER_BASE", None)
blocked = [Path(p).resolve() for p in [user_site, user_base] if p]
if blocked:
    cleaned = []
    for item in sys.path:
        try:
            resolved = Path(item).resolve()
        except Exception:
            cleaned.append(item)
            continue
        if any(resolved == base or base in resolved.parents for base in blocked):
            continue
        cleaned.append(item)
    sys.path[:] = cleaned
site.ENABLE_USER_SITE = False
'@ | Set-Content -Path $siteCustomize -Encoding utf8

    if (-not $SkipPythonPackages) {
        $projectRoot = Split-Path $PSScriptRoot -Parent
        $requirements = Join-Path $projectRoot "requirements.txt"
        $metashapeRequirements = Join-Path $projectRoot "metashape_requirements.txt"
        Write-Host "Installing bundled Python packages..."
        python -m pip install `
            --disable-pip-version-check `
            --only-binary=:all: `
            --index-url https://mirrors.aliyun.com/pypi/simple/ `
            --trusted-host mirrors.aliyun.com `
            --target $sitePackages `
            -r $requirements `
            -r $metashapeRequirements
    }
}

Write-Host ""
Write-Host "=== Done ==="
Write-Host "FFmpeg:  $(Join-Path $OutputDir 'ffmpeg')"
Write-Host "Python:  $(Join-Path $OutputDir 'python')"
Write-Host ""
Write-Host "Run 'pnpm tauri build' to bundle these into the installer."
