$ErrorActionPreference = "Stop"

function Find-Metashape {
    if ($env:XPANO_METASHAPE -and (Test-Path $env:XPANO_METASHAPE)) {
        return $env:XPANO_METASHAPE
    }

    $meta = Get-Command metashape.exe -ErrorAction SilentlyContinue
    if ($meta) {
        return $meta.Source
    }

    $candidates = @(
        "E:\FastProgram\Metashape\metashape.exe",
        "C:\Program Files\Agisoft\Metashape Pro\metashape.exe",
        "C:\Program Files\Agisoft\Metashape\metashape.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

Write-Host "[1/4] Checking ffmpeg..."
$ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    throw "ffmpeg.exe was not found in PATH. Install ffmpeg and add it to PATH before running xPano."
}

Write-Host "[2/4] Installing app Python dependencies..."
python -m pip install -r "$PSScriptRoot\..\requirements.txt"

Write-Host "[3/4] Locating Metashape..."
$metashapeExe = Find-Metashape
if (-not $metashapeExe) {
    throw "metashape.exe was not found. Add it to PATH, or set XPANO_METASHAPE to the full metashape.exe path."
}

$metaDir = Split-Path -Parent $metashapeExe
$metaPython = Join-Path $metaDir "python\python.exe"
if (-not (Test-Path $metaPython)) {
    throw "Metashape Python was not found at $metaPython"
}

Write-Host "[4/4] Installing Metashape Python dependencies..."
$metaReq = "$PSScriptRoot\..\metashape_requirements.txt"
$attempts = @(
    @("Tsinghua", @("-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--trusted-host", "pypi.tuna.tsinghua.edu.cn")),
    @("Aliyun", @("-i", "https://mirrors.aliyun.com/pypi/simple/", "--trusted-host", "mirrors.aliyun.com")),
    @("PyPI", @())
)
$installed = $false
foreach ($attempt in $attempts) {
    $name = $attempt[0]
    $indexArgs = $attempt[1]
    Write-Host "Installing Metashape Python dependencies from $name..."
    & $metaPython -m pip install --timeout 120 @indexArgs -r $metaReq
    if ($LASTEXITCODE -eq 0) {
        $installed = $true
        break
    }
    Write-Host "$name failed, trying next source..."
}
if (-not $installed) {
    throw "Failed to install Metashape Python dependencies from all sources."
}

Write-Host "Done."
