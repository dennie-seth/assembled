@echo off
setlocal

rem Prevent duplicate ComfyUI instances (checks if port 8188 is already listening)
netstat -ano | findstr /R /C:"TCP.*:8188.*LISTENING" >nul
if %ERRORLEVEL%==0 (
    echo [%date% %time%] ComfyUI already running on port 8188, skipping launch. >> "F:\ComfyUI\comfyui-startup.log"
    exit /b 0
)

cd /d F:\ComfyUI
echo [%date% %time%] Starting ComfyUI... >> "F:\ComfyUI\comfyui-startup.log"
"F:\ComfyUI\venv\Scripts\python.exe" main.py --listen 0.0.0.0 --port 8188 >> "F:\ComfyUI\comfyui-startup.log" 2>&1
echo [%date% %time%] ComfyUI process exited with code %ERRORLEVEL% >> "F:\ComfyUI\comfyui-startup.log"
