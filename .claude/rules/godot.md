---
paths: ["client/**/*.gd", "client/**/*.tscn", "client/**/*.tres"]
---

# Godot / GDScript conventions

- Indent with tabs (Godot's own default and what `gdformat`/the editor
  expect) — do not mix spaces into `.gd` files.
- Typed GDScript everywhere: `var health: int = 100`, typed function
  signatures and return types. Untyped `var` is only acceptable where the
  type is genuinely dynamic (e.g. a generic signal payload).
- Prefer signals over polling for cross-node communication. A node should
  not reach into another node's siblings/parents to read state every
  `_process` tick when a signal connection says the same thing declaratively.
- Tests: gdUnit4. TDD non-negotiable — test file before implementation, same
  as `cpp.md`.
- A `client/tests/*.gd` script is a `SceneTree`-extending script that must
  call `quit(0)`/`quit(1)` (or `get_tree().quit(...)`) itself once it's
  done — always run it under `timeout` (`cd client && timeout 600 godot
  --headless --script tests/<file>.gd`), never bare. A script that never
  calls quit hangs the whole `godot --headless` process forever, and
  nothing downstream is watching for that specific failure mode (T-0185:
  two such hangs kept their parent agent process alive indefinitely). See
  `verifyRouter.js`'s `client-godot-verify` route and the `verify` skill.
- Scene/node idioms: composition over deep inheritance chains; keep a
  scene's script focused on that scene's behavior, not shared logic (shared
  logic belongs in an autoload or a GDExtension class, not copy-pasted
  across scripts).
- `shared/` template tables (note templates, word lists) are the single
  source of truth for anything rendered from a `template_id`. Never
  hardcode a template string or duplicate an ID mapping in a scene or
  script — read through the GDExtension binding into `shared/`.
- GDExtension-side C++ for `client/` follows `.claude/rules/cpp.md` in full
  (RAII, clang-format, SOLID/DRY, getters/setters, Doxygen) — this file
  only covers the GDScript/scene layer.
