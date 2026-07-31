# Game Project — Environment Inventory

Read-only probe of the Windows host and WSL side, ahead of setting up the monorepo (Kanban web tool, C++/Drogon/Postgres server, Godot 4 + godot-cpp client, Docker dev Postgres, later GPU art/audio).

**Date:** 2026-07-31
**Host:** Windows 11, repo target drive F:\ (3.7T total, 3.0T free, 19% used)

## Inventory table

| Tool | Side | Status | Version | Notes |
|---|---|---|---|---|
| Claude Code | Win | ✅ present | 2.1.77 | |
| Git | Win | ✅ present | 2.46.0.windows.1 | Git-for-Windows Bash confirmed working |
| Node.js | Win | ✅ present | v24.14.0 | |
| npm | Win | ✅ present | 11.9.0 | |
| Python | Win | ✅ present | 3.12.1 | `python` and `python3` both resolve |
| Godot 4.x | Win | ❌ missing | — | Not on PATH; no install found |
| MSVC (cl.exe) | Win | ✅ present (not on PATH) | 14.34.31933 & 14.36.32532 | Under `F:\Program Files\Visual Studio\VC\Tools\MSVC\...`; needs Developer Command Prompt / `vcvars64.bat` to use from a plain shell |
| Clang (VS-bundled) | Win | ✅ present (not on PATH) | bundled w/ VS | `F:\Program Files\Visual Studio\VC\Tools\Llvm\bin\clang.exe` (clang-cl, clang-tidy, etc. also present) |
| CMake | Win | ✅ present (not on PATH) | 3.29.5-msvc4 | Bundled with VS at `Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`; no standalone install |
| SCons | Win | ❌ missing | — | Needed for godot-cpp/GDExtension builds; installable via `pip install scons` since Python is present |
| GPU driver | Win | ✅ present | Driver 581.57, CUDA 13.0 | NVIDIA GeForce RTX 3070, 8192 MiB VRAM total |
| Disk space (F:) | Win | ✅ ample | 3.0T free / 3.7T | |
| WSL distros | WSL | ⚠️ partial | `wsl -l -v` → only `rancher-desktop` (Running, v2) and `rancher-desktop-data` (Stopped, v2) | **No dedicated dev Ubuntu distro exists.** The plan calls for the repo to live at `~/dev/...` on WSL ext4, but the only real distro present is Rancher Desktop's minimal container-host appliance |
| OS (rancher-desktop distro) | WSL | ℹ️ n/a for dev use | "Rancher Desktop WSL Distribution" 0.94 | Minimal appliance OS, not a general-purpose dev environment |
| g++ / clang / cmake / make | WSL | ❌ missing | — | None present inside `rancher-desktop`; expected, since it's a container-runtime appliance, not a dev distro |
| git (WSL) | WSL | ✅ present | 2.52.0 | Present even in the appliance distro |
| Node.js (WSL) | WSL | ❌ missing | — | |
| psql / postgres client (WSL) | WSL | ❌ missing | — | |
| Docker engine | WSL | ✅ working | Docker 29.1.3 (client+server), containerd v2.2.0, runc 1.4.0 | Runs inside `rancher-desktop` distro; default runtime `runc` via `containerd` (Rancher Desktop's dockerd/moby stack) |
| docker compose (v2 plugin) | WSL | ❌ missing | — | `docker compose version` → "unknown command"; only the bare `docker` CLI is available |
| docker context | WSL | ✅ present | `default` only, unix socket | |
| Postgres on 5432 | Win+WSL | ⚠️ occupied by unrelated project | postgres:16-alpine | Port 5432 **is** reachable (confirmed via `Test-NetConnection`), forwarded by Rancher Desktop's `wslrelay`/`host-switch`, but it's bound by an existing, unrelated container `magic_wand_postgres` from another project. Two more Postgres containers also running: `mood_tracker-postgres-1` (host `127.0.0.1:15432`) and `progress_tracker-db-1` (internal-only, no host binding) |
| GPU access in WSL | WSL | ❌ not available | `nvidia-smi` not found in `rancher-desktop` | No GPU passthrough verified in the only WSL distro currently present; needs checking again once a real dev distro exists, plus `nvidia-container-toolkit` for Docker GPU passthrough |

## Gaps vs. plan

1. **No dev Ubuntu WSL distro.** Only `rancher-desktop` (+ its data companion) exist. The plan needs the monorepo at `~/dev/...` on a real distro with `apt`, `build-essential`, etc. — e.g. `wsl --install -d Ubuntu-24.04`. The current distro is a minimal appliance with no g++/clang/cmake/make/node/psql; it shouldn't be used as the dev distro.
2. **SCons missing everywhere probed** (Windows host and the rancher-desktop WSL distro). Required for godot-cpp/GDExtension builds via MSVC. Straightforward to add once Python is available in whichever environment builds Godot bindings (`pip install scons`).
3. **`docker compose` v2 plugin missing.** Only the bare `docker` CLI works in the Rancher Desktop distro; the dev Postgres stack as planned (compose file) needs the compose plugin installed/enabled.
4. **Port 5432 conflict.** An unrelated project's Postgres container (`magic_wand_postgres`) already owns host port 5432. The new project's dev Postgres will need a different host port mapping (e.g. 5433) or that container stopped first — don't assume 5432 is free.
5. **No GPU passthrough confirmed in WSL.** `nvidia-smi` isn't present in the only WSL distro available. Needs re-verification inside a real dev distro (WSL2 GPU passthrough is generally automatic on recent drivers, but Docker-side GPU access needs `nvidia-container-toolkit`) before the ComfyUI/SDXL and ACE-Step/Stable Audio phases.
6. **VRAM headroom is tight.** RTX 3070 has 8 GB VRAM total (with ~438 MiB already in use by desktop apps at probe time). SDXL is workable at 8GB but leaves little room to run an audio model (ACE-Step/Stable Audio) concurrently — expect to need low-VRAM modes, model offloading, or running art/audio phases sequentially rather than in parallel.
7. **Godot 4.x not installed anywhere.** Not found on the Windows host PATH; will need to download Godot 4 (with GDExtension/C++ support) plus fetch `godot-cpp` (typically a git submodule) before the client can be built.
8. **MSVC/Clang/CMake exist only via the full Visual Studio install, not on PATH.** They're present under `F:\Program Files\Visual Studio\...` (MSVC 14.34/14.36, VS-bundled Clang, CMake 3.29.5-msvc4) but require a Developer Command Prompt / `vcvars64.bat`, or adding them to PATH, to invoke from a plain shell — relevant since SCons/MSVC builds for godot-cpp happen on the Windows side per the plan.

## Bottom line

The Windows host is in reasonably good shape (Node, Python, Git, full Visual Studio with MSVC/Clang/CMake, a capable GPU) but is missing Godot 4 and SCons on PATH. The WSL side is the bigger gap: there's currently no dev Linux distro at all, only the Rancher Desktop container-runtime appliance — Docker itself works there, but it has no dev toolchain, no compose plugin, no GPU access, and its existing Postgres container already squats on port 5432.
