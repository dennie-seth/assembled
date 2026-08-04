# palette-extract

**T-0105** (`tasks/T-0105.md`): cluster an approved *interior* concept
sheet's colours down to N, order them into a value ramp, emit a LUT.
Resolves **V-5** (home palette hex set) and **P-A** (slot/ramp semantics)
per `docs/design/13-asset-pipeline.md` §6.10 -- as a process, not a fixed
hex table decided in the abstract.

## Why N=16 by default

`13-asset-pipeline.md` §7 leaves the exact slot count open (folded into
**P-B**, tuned per set). 16 is the starting point because:

- It's a full byte's worth of headroom without wasting index space --
  small enough that `mode 'P'` PNGs stay a single byte per pixel (true up
  to 256 anyway, but 16 keeps the LUT strip small and easy to eyeball).
- The source material (`05-art-direction.md` §3 family: concrete greys,
  oxide/rust, institutional green/ochre, deep shadow) is four *families*
  each wanting a few value steps -- 16 gives ~4 per family, enough to hold
  a value ramp within a family without over-clustering flat regions into
  near-duplicate slots.
- It's a documented starting point, not a constraint: `--n` is a CLI flag.
  If the first real descent (T-0073) shows visible banding or dead slots,
  re-run with a different N -- nothing downstream hardcodes 16.

## Value-ramp semantics

Slot 0 = darkest cluster (lowest Oklab lightness), slot N-1 = lightest,
monotonic in between. See `src/palette_extract/extract.py` docstring.
Clustering happens in Oklab space (perceptually uniform); each slot's
reported RGB is the **mean of the original sRGB pixels** assigned to that
cluster, not the Oklab centroid converted back -- keeps hex values inside
the sheet's actual colours.

**Interior sheets only** (`13-asset-pipeline.md` §6.10) -- mask sky/foliage
out of an exterior sheet before feeding it here, or don't use one.

## Install

```sh
cd tools/palette-extract
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Test / lint

```sh
.venv/bin/pytest -q
.venv/bin/ruff check .
```

## CLI

```sh
palette-extract --sheet assets/src/concept/signal_tower_material_sheet.png \
  --n 16 --out-dir assets/final/palette --name home_palette
```

Writes `<out-dir>/<name>.png` (N x 1 indexed LUT strip, pixel i = index i)
and `<out-dir>/<name>.json` (schema-compatible with
`asset_gate.palette.load_palette` -- `{"slots": [{"index", "hex", "name"}]}`).
Prints a JSON report (N + hex ordered by value) to stdout.

## Wiring into the gate

The emitted `<name>.json` is drop-in for `asset-gate`'s `--palette` flag:

```sh
asset-gate art-palette <tile.png> --palette assets/final/palette/home_palette.json
```

`config/palette.placeholder.json` in `tools/asset-gate` is left as-is (it's
a documented placeholder fixture, still used by that package's own tests)
-- real callers now point `--palette` at the locked LUT here instead.
