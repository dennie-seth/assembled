# server

C++ / Drogon / PostgreSQL backend. This is the **dev-environment scaffold**
(T-0040/T-0041/T-0042/T-0050): a real build/test/DB toolchain and a
`GET /health` proof-of-life, not the notes/items/economy API from
`docs/design/03-net-protocol.md` and `docs/design/04-data-model.md` yet.

## Dependency manager: apt, not vcpkg/Conan

Drogon is installed from Ubuntu's own package archive (`libdrogon-dev`,
noble/universe), not vcpkg, Conan, or a from-source `FetchContent` build.

**Why:**

- Ubuntu 24.04 (noble) universe ships `libdrogon-dev` 1.8.7, already built
  with PostgreSQL support (it links `libpq`). Both local dev (WSL
  `Ubuntu-24.04`) and `ci-server`'s runner (`ubuntu-latest`, currently noble)
  are the same OS/version, so the exact same package resolves in both places
  — no cross-environment drift to debug.
- It ships a real CMake package config
  (`/usr/lib/x86_64-linux-gnu/cmake/Drogon/DrogonConfig.cmake`), so
  `find_package(Drogon CONFIG REQUIRED)` behaves identically to a vcpkg/Conan
  install. Switching dependency managers later is a one-line change in
  `CMakeLists.txt`, not a rewrite — the choice is reversible by design.
- No from-source Drogon build means no multi-minute CI cache warm-up and a
  much smaller footprint, which matches this task's brief ("keep it
  reversible and minimal").

**Trade-off, noted rather than hidden:** the apt build of Drogon was
compiled with every optional DB backend (Postgres, MySQL/MariaDB, SQLite3)
plus Redis and Brotli support, so `DrogonConfig.cmake` unconditionally
`find_dependency()`s all of those at configure time even though this project
only uses Postgres. That's why the apt install list below looks longer than
"just Postgres" — every package on it is required for `find_package(Drogon
CONFIG REQUIRED)` to succeed, confirmed by walking the configure errors one
at a time until it converged.

## Local setup (WSL / Ubuntu 24.04)

Install once:

```sh
sudo apt-get update
sudo apt-get install -y \
  build-essential cmake git clang-format \
  libdrogon-dev libjsoncpp-dev libpq-dev uuid-dev zlib1g-dev \
  libsqlite3-dev libmariadb-dev libbrotli-dev libhiredis-dev libyaml-cpp-dev \
  docker-compose-plugin
```

## Configure, build, test

```sh
cmake -S server -B server/build -DCMAKE_BUILD_TYPE=Release
cmake --build server/build --parallel
ctest --test-dir server/build --output-on-failure   # non-DB tests only
```

For the full suite including DB-gated tests, use the `db` CMake preset
(defined in `server/CTestPresets.json`) instead of setting `DATABASE_URL`
manually. The preset injects it automatically — no `export` or inline
env-var prefix needed:

```sh
cd server
docker compose up -d && sleep 10   # wait for Postgres healthy
rm -rf build
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --preset db --output-on-failure   # injects DATABASE_URL via preset
```

**Note:** `$()` command substitution and `DATABASE_URL=...` inline prefixes
are blocked in the reviewer agent's Bash tool. Always use
`ctest --preset db` for the DB-gated run — never `export DATABASE_URL=...`
or `DATABASE_URL=... ctest ...`.

`server_tests` links `doctest` (fetched via CMake `FetchContent`, cached in
CI) and covers:

- `server CI toolchain is wired` — the original T-0032 smoke test.
- `GET /health returns 200 with {"status":"ok"}` — starts the real Drogon
  app on a loopback test port, hits it with Drogon's own `HttpClient`, and
  shuts it down. Proves Drogon actually builds *and serves*, not just
  compiles.
- `migrations apply against a live Postgres` — gated on `DATABASE_URL`
  (early-return guard, not `doctest::skip`), so it registers with `ctest -N`
  always but executes SQL only when DATABASE_URL is set. The test drops
  `schema_migrations` before running to be repeatable against a persistent
  dev DB (migrations are idempotent, so re-applying is safe).

## Dev Postgres

```sh
cd server
docker compose up -d      # postgres:16, binds 127.0.0.1:5433 -> 5432
docker compose ps          # wait for "healthy"
docker compose down        # stop (add -v to also wipe the volume)
```

Port **5433**, not 5432: WSL2 mirrored networking shares the Windows host's
port namespace (`docs/PLAN.md` "Environment Notes"), so 5432 collides with
whatever Postgres the host side already has bound. `ci-server`'s runner is
isolated and keeps the default 5432 — see `.github/workflows/ci-server.yml`.

## Configuration

Everything is env-var driven; nothing is committed:

| Variable | Example | Used by |
|---|---|---|
| `DATABASE_URL` | `postgresql://assembled:assembled@localhost:5433/assembled_dev` | `Database::fromEnv()`, `migrate`, the migration test |
| `PORT` | `8080` (default) | `server`'s listener |

## Run the server

```sh
DATABASE_URL=postgresql://assembled:assembled@localhost:5433/assembled_dev \
  ./server/build/server
curl http://127.0.0.1:8080/health   # {"status":"ok"}
```

## Migrations

Plain SQL, no ORM — `server/migrations/NNN_slug.sql` (up) paired with
`server/migrations/NNN_slug.down.sql` (down), tracked in a
`schema_migrations(version, applied_at)` table. See `.claude/rules/sql.md`
and the `new-migration` skill for the conventions; use that skill to scaffold
the next migration rather than hand-rolling the version number.

Apply pending migrations with the `migrate` tool:

```sh
DATABASE_URL=postgresql://assembled:assembled@localhost:5433/assembled_dev \
  ./server/build/migrate
```

`migrate` applies every `*.sql` file in `server/migrations/` (excluding
`*.down.sql`) whose numeric prefix is greater than the current
`schema_migrations` max version, in order, and is a no-op if everything is
already applied. `001_init.sql` enables the `pgcrypto` extension
(`gen_random_uuid()`), since every table in `docs/design/04-data-model.md`
uses a UUID primary key.

To verify a migration's `up`/`down`/`up` idempotency by hand (what the
`verify` skill runs for `server/**/migrations/**` changes):

```sh
psql "$DATABASE_URL" -f server/migrations/001_init.sql
psql "$DATABASE_URL" -f server/migrations/001_init.down.sql
psql "$DATABASE_URL" -f server/migrations/001_init.sql
```

## Layout

```
server/
|- CMakeLists.txt
|- docker-compose.yml     # dev Postgres
|- migrations/            # NNN_slug.sql / NNN_slug.down.sql
|- include/assembled_server/   # public headers (Doxygen-documented)
|- src/                   # HealthController, Database, MigrationRunner, main, migrate
\- test/                  # doctest: smoke, health (integration), migration (DB-gated)
```
