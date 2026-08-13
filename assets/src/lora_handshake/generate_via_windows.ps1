# T-0167 LoRA Handshake Generation Script
# Run this from Windows PowerShell (not WSL) to generate the LoRA-conditioned concept sheet.
# Requires: ComfyUI running at http://127.0.0.1:8188 with soviet_brutalism_style_v1.safetensors in models/loras/

param(
    [string]$ComfyUIUrl = "http://127.0.0.1:8188",
    [string]$WslRoot = "\\wsl.localhost\Ubuntu-24.04\home\dennieseth\dev\assembled-board\worktrees\T-0167"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$WorkflowPath = "$WslRoot\assets\src\lora_handshake\comfyui_workflow_ready.json"
$TemplatePath = "$WslRoot\assets\src\concept\signal_tower_material_template.png"
$OutputPng    = "$WslRoot\assets\src\concept\signal_tower_material_sheet_lora.png"

Write-Host "=== T-0167 LoRA Handshake Generation ===" -ForegroundColor Cyan
Write-Host "ComfyUI URL: $ComfyUIUrl"
Write-Host "Workflow:    $WorkflowPath"
Write-Host "Template:    $TemplatePath"
Write-Host "Output:      $OutputPng"
Write-Host ""

# 1. Verify ComfyUI is reachable
Write-Host "Checking ComfyUI..." -ForegroundColor Yellow
try {
    $stats = Invoke-RestMethod "$ComfyUIUrl/system_stats" -TimeoutSec 10
    Write-Host "ComfyUI is up. Device: $($stats.system.comfyui_version)" -ForegroundColor Green
} catch {
    Write-Host "ERROR: ComfyUI not reachable at $ComfyUIUrl" -ForegroundColor Red
    Write-Host "Start it with: F:\ComfyUI\venv\Scripts\python.exe F:\ComfyUI\main.py --listen 0.0.0.0 --port 8188"
    exit 1
}

# 2. Upload the template image to ComfyUI
Write-Host "Uploading template image..." -ForegroundColor Yellow
$templateBytes = [System.IO.File]::ReadAllBytes($TemplatePath)
$boundary = [System.Guid]::NewGuid().ToString()
$body = [System.Text.StringBuilder]::new()
$body.AppendLine("--$boundary") | Out-Null
$body.AppendLine('Content-Disposition: form-data; name="image"; filename="signal_tower_material_template.png"') | Out-Null
$body.AppendLine("Content-Type: image/png") | Out-Null
$body.AppendLine("") | Out-Null

$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body.ToString())
$endBoundary = [System.Text.Encoding]::UTF8.GetBytes("`r`n--$boundary--`r`n")

$fullBody = New-Object byte[] ($bodyBytes.Length + $templateBytes.Length + $endBoundary.Length)
[System.Buffer]::BlockCopy($bodyBytes, 0, $fullBody, 0, $bodyBytes.Length)
[System.Buffer]::BlockCopy($templateBytes, 0, $fullBody, $bodyBytes.Length, $templateBytes.Length)
[System.Buffer]::BlockCopy($endBoundary, 0, $fullBody, $bodyBytes.Length + $templateBytes.Length, $endBoundary.Length)

try {
    $uploadResp = Invoke-RestMethod "$ComfyUIUrl/upload/image" -Method POST `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $fullBody
    $uploadedName = $uploadResp.name
    Write-Host "Uploaded as: $uploadedName" -ForegroundColor Green
} catch {
    Write-Host "ERROR uploading template: $_" -ForegroundColor Red
    exit 1
}

# 3. Load workflow and patch the LoadImage node with the uploaded name
Write-Host "Preparing workflow..." -ForegroundColor Yellow
$workflow = Get-Content $WorkflowPath -Raw | ConvertFrom-Json

# The LoadImage node (node "10") needs the uploaded image name
$workflow."10".inputs.image = $uploadedName

$body = @{
    prompt    = $workflow
    client_id = "t0167-handshake-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
} | ConvertTo-Json -Depth 20

# 4. Submit to ComfyUI
Write-Host "Submitting workflow to ComfyUI..." -ForegroundColor Yellow
try {
    $resp = Invoke-RestMethod "$ComfyUIUrl/prompt" -Method POST -Body $body -ContentType "application/json"
    $promptId = $resp.prompt_id
    Write-Host "Queued. prompt_id: $promptId" -ForegroundColor Green
} catch {
    Write-Host "ERROR submitting workflow: $_" -ForegroundColor Red
    exit 1
}

# 5. Poll until complete
Write-Host "Waiting for generation (SDXL 1024x1024 @ 30 steps with LoRA, ~60s)..." -ForegroundColor Yellow
$timeout = 600  # seconds
$elapsed = 0
$pollInterval = 3

while ($elapsed -lt $timeout) {
    Start-Sleep $pollInterval
    $elapsed += $pollInterval

    try {
        $history = Invoke-RestMethod "$ComfyUIUrl/history/$promptId"
        $entry = $history.$promptId
        if ($entry -and $entry.status.completed) {
            Write-Host "Generation complete! (${elapsed}s)" -ForegroundColor Green
            break
        }
        if ($entry -and $entry.status.status_str -eq "error") {
            Write-Host "ERROR: ComfyUI reported an error for $promptId" -ForegroundColor Red
            Write-Host ($entry | ConvertTo-Json -Depth 5)
            exit 1
        }
    } catch {
        # transient poll error — keep waiting
    }

    if ($elapsed % 30 -eq 0) {
        Write-Host "  ...still waiting (${elapsed}s elapsed)..."
    }
}

if ($elapsed -ge $timeout) {
    Write-Host "ERROR: Timed out after ${timeout}s waiting for generation" -ForegroundColor Red
    exit 1
}

# 6. Fetch the output image
Write-Host "Fetching output image..." -ForegroundColor Yellow
$history = Invoke-RestMethod "$ComfyUIUrl/history/$promptId"
$entry = $history.$promptId

# Find the first image in any output node
$imageInfo = $null
foreach ($nodeId in $entry.outputs.PSObject.Properties.Name) {
    $nodeOutput = $entry.outputs.$nodeId
    if ($nodeOutput.images -and $nodeOutput.images.Count -gt 0) {
        $imageInfo = $nodeOutput.images[0]
        break
    }
}

if (-not $imageInfo) {
    Write-Host "ERROR: No output images found in history" -ForegroundColor Red
    Write-Host ($entry.outputs | ConvertTo-Json -Depth 5)
    exit 1
}

$fname    = $imageInfo.filename
$subfolder = $imageInfo.subfolder
$imgType  = $imageInfo.type

$viewUrl = "$ComfyUIUrl/view?filename=$fname&subfolder=$subfolder&type=$imgType"
Write-Host "Downloading: $viewUrl" -ForegroundColor Yellow

try {
    $imgResp = Invoke-WebRequest $viewUrl
    [System.IO.File]::WriteAllBytes($OutputPng, $imgResp.Content)
    $size = (Get-Item $OutputPng).Length
    Write-Host "Saved: $OutputPng ($size bytes)" -ForegroundColor Green
} catch {
    Write-Host "ERROR downloading image: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Generation complete ===" -ForegroundColor Cyan
Write-Host "prompt_id: $promptId"
Write-Host "Output:    $OutputPng"
Write-Host ""
Write-Host "Next steps (in WSL):"
Write-Host "  1. Visual comparison: open both images and note any style differences"
Write-Host "     Original: assets/src/concept/signal_tower_material_sheet.png"
Write-Host "     LoRA run: assets/src/concept/signal_tower_material_sheet_lora.png"
Write-Host "  2. Write provenance sidecar (use prompt_id above)"
Write-Host "  3. Update ASSET_PROVENANCE.md (replace PENDING row)"
Write-Host "  4. Update docs/decision-log.md DL-15 with actual comparison"
Write-Host "  5. Commit: git add assets/src/concept/signal_tower_material_sheet_lora.png ..."
Write-Host ""
Write-Host "prompt_id=$promptId" > "$WslRoot\assets\src\lora_handshake\last_prompt_id.txt"
Write-Host "Written prompt_id to last_prompt_id.txt for reference."
