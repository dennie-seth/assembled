@echo off
REM assembled: ComfyUI launcher, version-controlled per T-0322.
REM
REM IMPORTANT -- this is a RECONSTRUCTION, not a byte-exact mirror. This agent has no
REM filesystem or shell access to the Windows host (F:\), only ComfyUI's own HTTP API. This file
REM is built from (a) the exact two lines quoted in T-0322's card body, (b) the live /system_stats
REM argv this card's own implementer session queried directly, and (c) docs/comfyui-setup.md's
REM original T-0070 launch line. Any host-side logic not shown here (a duplicate-instance guard,
REM logging redirects, etc. -- T-0322's card body references a guard that must not be removed, but
REM never quotes its contents) is NOT reproduced below, because fabricating it would be worse than
REM omitting it. The next time a human or an agent with host access touches the real
REM F:\ComfyUI\start-comfyui.bat, paste its actual full contents back into this file so this stops
REM being a reconstruction. Do not overwrite the live host file from this one without diffing first.
REM
REM Determinism regime -- see docs/comfyui-setup.md#determinism and
REM tools/board/ops/comfyui-regime.json (the machine-readable source of truth
REM tools/board/scripts/checkComfyUiRegime.js checks the live server against).
REM
REM T-0272/T-0317 rounds 10-12 found that forcing --deterministic and/or
REM CUBLAS_WORKSPACE_CONFIG on the dual-IPAdapter+ControlNet profile graph reproducibly destroys
REM coherence (0/6 and 0/8 fresh seeds respectively), while baseline (neither flag) is the only
REM regime that has ever produced a coherent frame (attempt 39) -- though round 12 shows baseline
REM alone does not reliably reproduce it either (0/8). The live regime as of this card is BASELINE.
REM Do not uncomment the determinism lines below without updating comfyui-regime.json to match --
REM the checker fails loudly on exactly that kind of drift, in either direction.

setlocal

REM ---- BASELINE regime (live as of T-0322, 2026-09-07) ----
"F:\ComfyUI\venv\Scripts\python.exe" main.py --listen 0.0.0.0 --port 8188

REM ---- DETERMINISTIC regime (T-0317 round 10) -- reproducible, but destroys coherence on the
REM      §24-e profile graph. Only switch to this deliberately, for a card that needs
REM      cross-restart reproducibility more than that graph's own coherence, and only with
REM      comfyui-regime.json's "deterministic" field updated to `true` to match:
REM set CUBLAS_WORKSPACE_CONFIG=:4096:8
REM "F:\ComfyUI\venv\Scripts\python.exe" main.py --listen 0.0.0.0 --port 8188 --deterministic
