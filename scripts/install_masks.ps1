param(
    [ValidateSet("cuda", "cpu")]
    [string]$Backend = "cuda",
    [string]$Python = "python",
    [string]$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple",
    [string]$PipTrustedHost = "pypi.tuna.tsinghua.edu.cn",
    [string]$TorchCudaIndex = "https://download.pytorch.org/whl/cu128",
    [switch]$SkipModelDownload
)

$ErrorActionPreference = "Stop"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Requirements = Join-Path $Root "mask_requirements.txt"

function Invoke-PythonChecked {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE`: $Python $($Arguments -join ' ')"
    }
}

if (-not (Get-Command $Python -ErrorAction SilentlyContinue) -and -not (Test-Path $Python)) {
    throw "Python was not found: $Python"
}
if (-not (Test-Path $Requirements)) {
    throw "Mask requirements file was not found: $Requirements"
}

$ResolvedPython = & $Python -c "import sys; print(sys.executable)"
if ($LASTEXITCODE -ne 0 -or -not $ResolvedPython) {
    throw "Unable to run Python: $Python"
}
$Python = ($ResolvedPython | Select-Object -First 1).Trim()

Write-Host "Mask Python: $Python"
Write-Host "Backend: $Backend"
Write-Host "[1/4] Updating pip..."
Invoke-PythonChecked -Arguments @("-m", "pip", "install", "--disable-pip-version-check", "--timeout", "120", "--upgrade", "pip")

Write-Host "[2/4] Installing image-processing dependencies..."
Invoke-PythonChecked -Arguments @(
    "-m", "pip", "install", "--disable-pip-version-check", "--timeout", "120",
    "-i", $PipIndex, "--trusted-host", $PipTrustedHost,
    "numpy>=1.26,<3", "Pillow>=10,<12", "opencv-python>=4.10,<5"
)

Write-Host "[3/4] Installing PyTorch and torchvision..."
$torchIndex = if ($Backend -eq "cuda") { $TorchCudaIndex } else { "https://download.pytorch.org/whl/cpu" }
Invoke-PythonChecked -Arguments @(
    "-m", "pip", "install", "--disable-pip-version-check", "--timeout", "180",
    "--index-url", $torchIndex, "torch>=2.8,<3", "torchvision>=0.23,<1"
)

Write-Host "[4/4] Verifying the runtime..."
$verify = @'
import cv2
import numpy
from PIL import Image
import torch
import torchvision
print(f"torch={torch.__version__}")
print(f"torchvision={torchvision.__version__}")
print(f"CUDA available={torch.cuda.is_available()}")
'@
Invoke-PythonChecked -Arguments @("-c", $verify)

if ($Backend -eq "cuda") {
    Invoke-PythonChecked -Arguments @("-c", "import torch; raise SystemExit(0 if torch.cuda.is_available() else 'CUDA PyTorch installed, but CUDA is unavailable. Check the NVIDIA driver and GPU compatibility.')")
}

if (-not $SkipModelDownload) {
    Write-Host "Downloading and validating Mask R-CNN weights (first install only)..."
    $modelCheck = @'
from torchvision.models.detection import MaskRCNN_ResNet50_FPN_Weights, maskrcnn_resnet50_fpn
maskrcnn_resnet50_fpn(weights=MaskRCNN_ResNet50_FPN_Weights.DEFAULT)
print("Mask R-CNN weights are ready.")
'@
    Invoke-PythonChecked -Arguments @("-c", $modelCheck)
}

Write-Host "Mask dependencies installed successfully."
Write-Host "Configure xPano to use this Python: $Python"
