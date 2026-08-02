"""CLI entrypoint: `sfx-synth render <name>` / `sfx-synth render-all`.

Renders named recipe(s) to WAV + a provenance JSON sidecar under
`assets/out/audio/` (gitignored -- regenerable from the recipe + seed,
P-1/P-3). Mirrors `comfy_client.cli`'s shape: prints the result as JSON
on stdout, the form a caller (or the `audio` agent) parses.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from sfx_synth.pipeline import render_recipe_to_wav_bytes
from sfx_synth.provenance import build_provenance_record, provenance_to_dict
from sfx_synth.recipes import ALL_RECIPES

DEFAULT_OUT_DIR = Path("assets/out/audio")


def _render_one(name: str, out_dir: Path) -> dict:
    if name not in ALL_RECIPES:
        raise KeyError(f"unknown recipe {name!r}, expected one of {sorted(ALL_RECIPES)}")
    recipe = ALL_RECIPES[name]
    encoded = render_recipe_to_wav_bytes(recipe)
    provenance = build_provenance_record(recipe, encoded)

    out_dir.mkdir(parents=True, exist_ok=True)
    wav_path = out_dir / f"{name}.wav"
    wav_path.write_bytes(encoded)
    provenance_dict = provenance_to_dict(provenance)
    (out_dir / f"{name}.provenance.json").write_text(json.dumps(provenance_dict, indent=2))

    return {"name": name, "path": str(wav_path), "provenance": provenance_dict}


def _cmd_render(args: argparse.Namespace) -> int:
    try:
        result = _render_one(args.name, Path(args.out_dir))
    except KeyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


def _cmd_render_all(args: argparse.Namespace) -> int:
    results = [_render_one(name, Path(args.out_dir)) for name in ALL_RECIPES]
    print(json.dumps(results, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sfx-synth")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("render", help="render one named recipe to WAV")
    p.add_argument("name")
    p.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    p.set_defaults(func=_cmd_render)

    p = sub.add_parser("render-all", help="render every recipe to WAV")
    p.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    p.set_defaults(func=_cmd_render_all)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
