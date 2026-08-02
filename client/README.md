# Client Dev-Env (T-0060 / T-0061)

**Author:** Claude (Sonnet 5)

This is the real Phase 5 client: a Godot 4 project plus a minimal
GDExtension built via godot-cpp + SCons. It is **not the game yet** — the
only content is `AssembledPing`, a trivial `RefCounted` class that proves
the C++ <-> GDScript binding works end-to-end. Everything else in Phase 5
(`T-0062`+) builds on top of this scaffold.

The disposable CI feasibility spike this replaces lives at
`.github/ci-spike/godot-client/` (superseded, not deleted — see
`docs/ci-notes.md`).

## Version pin — read this before touching godot-cpp

- **Engine:** Godot **4.7.1** (matches `GODOT_VERSION` used everywhere else
  in this repo's CI).
- **godot-cpp:** submodule at `client/godot-cpp`, pinned to the git tag
  **`godot-4.5-stable`**.

These are deliberately different lines. `godot-cpp` lags the engine's own
release cadence — as of this writing it publishes branches/tags only up to
`4.5` (`godot-4.5-stable`), nothing for `4.6`/`4.7`
(confirmed via `git ls-remote --heads/--tags
https://github.com/godotengine/godot-cpp`). This is **not a bug**: Godot's
GDExtension ABI has been forward-compatible across `4.x` minor releases
since `4.1` — an extension built against an older API surface loads in a
newer engine, gated by `compatibility_minimum` in the `.gdextension` file
(here set to `"4.1"`).

**This was verified directly, not assumed.** Locally, in WSL:

1. Built `client/godot-cpp` (tag `godot-4.5-stable`) and
   `client/src/*.cpp` into `libassembled_client.linux.template_debug.x86_64.so`
   via `scons platform=linux target=template_debug`.
2. Ran the **Godot 4.7.1** engine binary headless against the project:
   `godot --headless --import` — no GDExtension errors.
3. Ran `godot --headless --script tests/smoke_test.gd`, which calls
   `ClassDB.class_exists("AssembledPing")` and then actually instantiates
   the class and calls `ping()` — this fails loudly (exit 1) if the
   extension didn't load or the ABI mismatched. Result: **exit 0**,
   `SMOKE TEST PASS: AssembledPing GDExtension loaded and round-tripped
   correctly`.
4. Built `template_release` and ran a full
   `godot --headless --export-release "Linux"` — the exported package
   correctly bundled `libassembled_client.linux.template_release.x86_64.so`
   alongside the game binary.

Conclusion: **no engine downgrade needed.** Keep building against
`godot-cpp` `godot-4.5-stable` and running/exporting on engine `4.7.1`
until godot-cpp cuts a ref that actually matches the engine's line — bump
`GODOT_CPP_REF` then, and re-run this same verification before trusting it.
Full narrative in `docs/ci-notes.md` under "T-0060".

## Layout

```
client/
  project.godot              # Godot 4 project (config/features 4.5, so it
                              # opens cleanly in either a 4.5 or 4.7 editor)
  main.tscn / main.gd        # proof-of-life scene: calls AssembledPing on
                              # _ready() and prints the result
  assembled_client.gdextension
  export_presets.cfg         # Windows Desktop + Linux presets (CI-owned,
                              # not gitignored — see .gitignore)
  SConstruct                 # builds src/*.cpp against godot-cpp
  src/
    assembled_ping.h/.cpp    # the AssembledPing class
    register_types.h/.cpp    # GDExtension entry point
  godot-cpp/                 # git submodule, pinned to godot-4.5-stable
  tests/
    smoke_test.gd            # headless CI smoke test (see below)
  bin/                       # built .so/.dll (gitignored)
```

## Local setup (WSL/Linux — mirrors CI's `linux-export` job)

Everything below assumes a POSIX shell in the repo root's `client/`
directory, and Godot's Linux/X11 build system dependencies installed
(`build-essential`, `libx11-dev`, `libxcursor-dev`, `libxinerama-dev`,
`libxi-dev`, `libxrandr-dev`, `libxrender-dev`, `libgl1-mesa-dev`,
`libglu1-mesa-dev`, `libasound2-dev`, `libpulse-dev`, `libudev-dev`,
`libssl-dev`, `libwayland-dev`).

### 1. Clone with submodules (or init after the fact)

```sh
git submodule update --init --recursive
```

### 2. Install SCons

```sh
python3 -m pip install --user scons
```

### 3. Build the GDExtension

```sh
cd client
scons platform=linux target=template_debug -j$(nproc)     # dev/editor use
scons platform=linux target=template_release -j$(nproc)   # export use
```

First build compiles all of godot-cpp (~2 min on a modern multi-core box)
and is cached afterwards (`client/.sconsign.dblite`, gitignored).

### 4. Get a Godot 4.7.1 editor/export binary

Any of: the `chickensoft-games/setup-godot` action output (what CI uses),
a manual download of `Godot_v4.7.1-stable_linux.x86_64` from
[godotengine/godot releases](https://github.com/godotengine/godot/releases/tag/4.7.1-stable),
or your own install. For headless export you also need the matching
export templates (`Godot_v4.7.1-stable_export_templates.tpz`, extracted to
`~/.local/share/godot/export_templates/4.7.1.stable/`).

### 5. Import + run headless

```sh
godot --headless --import
godot --headless --script tests/smoke_test.gd   # proof-of-life check, exits 1 on failure
```

To actually run the (non-quitting) main scene instead of the smoke test:

```sh
godot --headless   # or drop --headless to see the window
```

### 6. Export

```sh
mkdir -p build/linux
godot --headless --export-release "Linux" build/linux/assembled.x86_64
```

Windows export requires the `template_debug`/`template_release` DLLs
built with MSVC (`scons platform=windows ...`), which isn't available in
WSL — that leg is built and verified by `ci-client.yml`'s
`windows-export` job on `windows-latest`.

## Validation the `reviewer` agent (or a human) can run

`client/tests/smoke_test.gd` is the minimum bar: it asserts
`AssembledPing` is registered, calls `ping()`, and checks both the return
value and the `ping_count` property round-trip. It's a plain
`SceneTree`-extending script (`godot --headless --script ...`), not a
gdUnit4 suite — deliberately, since this task is the dev-env + proof-of-life,
not real client functionality. `T-0061`'s own acceptance criteria calls
for a gdUnit4 binding test; wire the gdUnit4 addon in when real
GDExtension classes start landing (see `.claude/skills/new-gdextension-class`).

CI (`ci-client.yml`) runs this smoke test on both platforms, between
`--import` and `--export-release`, so a broken extension fails the job
before wasting time on export.

## Windows (native, outside WSL)

Per `docs/PLAN.md`'s environment notes, the client is also expected to be
worked on natively on Windows (separate checkout, git as sync — WSL's 9P
bridge is too slow for iterative editor use). The steps are the same:
`scons platform=windows target=template_debug` (needs Visual Studio's MSVC
build tools on PATH, or run from a "Developer Command Prompt"), then open
`project.godot` in a Godot 4.7.1 editor.
