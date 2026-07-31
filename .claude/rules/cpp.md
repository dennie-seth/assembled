---
paths: ["server/**", "client/**"]
---

# C++ conventions

- Format: `clang-format`, LLVM base style, 4-space indent, 100 column limit.
  See `.clang-format` at repo root.
- Build: CMake. No ORM — plain SQL + libpqxx/DbClient against Postgres.
- Tests: doctest. TDD non-negotiable — test file before implementation.
- RAII everywhere. No manual `new`/`delete` in application code.
- `shared/` headers are the single source of truth for wire structs and
  note template IDs. Never redefine a struct or template ID locally in
  `server/` or `client/` — include from `shared/`.
- Client (Godot/GDExtension) and server (Drogon) both depend on `shared/`;
  neither depends on the other.
