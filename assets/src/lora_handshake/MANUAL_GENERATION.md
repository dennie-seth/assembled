# T-0167 Manual Generation Guide

ComfyUI is not reachable from WSL due to a Windows Firewall block (see
`docs/comfyui-setup.md`). Run the LoRA handshake generation from the Windows
host using one of the two methods below.

## Method A — API submission (recommended, no UI needed)

Run this on the **Windows host** (PowerShell or cmd, not WSL):

```powershell
# 1. Make sure ComfyUI is running:
#    F:\ComfyUI\venv\Scripts\python.exe F:\ComfyUI\main.py --listen 0.0.0.0 --port 8188

# 2. Copy the template image to ComfyUI inputs:
Copy-Item "\\wsl.localhost\Ubuntu-24.04\home\dennieseth\dev\assembled-board\worktrees\T-0167\assets\src\concept\signal_tower_material_template.png" `
    "F:\ComfyUI\input\signal_tower_material_template.png"

# 3. Submit the workflow:
$workflow = Get-Content "\\wsl.localhost\Ubuntu-24.04\home\dennieseth\dev\assembled-board\worktrees\T-0167\assets\src\lora_handshake\comfyui_workflow_ready.json" | ConvertFrom-Json
$body = @{ prompt = $workflow; client_id = "t0167-handshake" } | ConvertTo-Json -Depth 20
$resp = Invoke-RestMethod -Uri "http://127.0.0.1:8188/prompt" -Method POST -Body $body -ContentType "application/json"
$promptId = $resp.prompt_id
Write-Host "Queued: $promptId"

# 4. Wait for completion and fetch output:
do {
    Start-Sleep 3
    $history = Invoke-RestMethod "http://127.0.0.1:8188/history/$promptId"
    $done = $history.$promptId.status.completed
} while (-not $done)

$images = $history.$promptId.outputs.PSObject.Properties.Value.images
$fname = $images[0].filename
$outBytes = Invoke-WebRequest "http://127.0.0.1:8188/view?filename=$fname&type=output" | Select-Object -ExpandProperty Content
$destWsl = "\\wsl.localhost\Ubuntu-24.04\home\dennieseth\dev\assembled-board\worktrees\T-0167\assets\src\concept\signal_tower_material_sheet_lora.png"
[System.IO.File]::WriteAllBytes($destWsl, $outBytes)
Write-Host "Saved to WSL: $destWsl"
```

## Method B — ComfyUI web UI

1. Open `http://127.0.0.1:8188` in a browser on the Windows host.
2. Click the menu → "Load" and select `assets/src/lora_handshake/comfyui_workflow_ready.json`
   (accessible at `\\wsl.localhost\Ubuntu-24.04\home\dennieseth\dev\assembled-board\worktrees\T-0167\...`).
3. Before queuing, upload `assets/src/concept/signal_tower_material_template.png`
   to ComfyUI's inputs (drag onto the `LoadImage` node or use Upload).
4. Click Queue Prompt.
5. When done, right-click the output image → Save As →
   `signal_tower_material_sheet_lora.png` → save to
   `\\wsl.localhost\Ubuntu-24.04\home\dennieseth\dev\assembled-board\worktrees\T-0167\assets\src\concept\`

## After generation

Once the PNG is at `assets/src/concept/signal_tower_material_sheet_lora.png`:

```bash
# From WSL, in the worktree:
cd /home/dennieseth/dev/assembled-board/worktrees/T-0167

# Install comfy-client (if not done):
cd tools/comfy-client && pip install -e ".[dev]" && cd ../..
cd tools/gen-client-base && pip install -e ".[dev]" && cd ../..

# OR just write the provenance JSON manually (from the workflow output):
# The provenance sidecar needs:
#   {
#     "model": "sd_xl_base_1.0.safetensors",
#     "model_license": "CreativeML Open RAIL++-M",
#     "model_hash": null,   # fill from F:\ComfyUI\models\checkpoints\sha256
#     "prompt": "...",      # from the recipe JSON
#     "negative_prompt": "...",
#     "seed": 3101,
#     "steps": 30,
#     "cfg": 7.0,
#     "width": 1024,
#     "height": 1024,
#     "workflow_hash": "",  # sha256 of the ComfyUI workflow JSON
#     "prompt_id": "<the prompt_id from step 3 above>",
#     "concept_hash": "",   # sha256 of signal_tower_material_template.png
#     "denoise": 0.9,
#     "conditioning_source": "assets/src/concept/signal_tower_material_template.png",
#     "lora_name": "soviet_brutalism_style_v1",
#     "lora_weight": 0.75,
#     "lora_license": "CreativeML Open RAIL++-M",
#     "base_concept_hash": ""  # sha256 of signal_tower_material_sheet.png
#   }

# Then update ASSET_PROVENANCE.md (remove "PENDING GENERATION") and
# update docs/decision-log.md DL-15 with the actual visual comparison.

# Finally commit:
git add assets/src/concept/signal_tower_material_sheet_lora.png
git add assets/src/concept/signal_tower_material_sheet_lora.provenance.json
git add ASSET_PROVENANCE.md docs/decision-log.md
git commit -m "feat(assets/T-0167): LoRA handshake PNG + provenance — direction confirmed"
```
