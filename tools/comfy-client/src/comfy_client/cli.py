"""CLI entrypoint: `comfy-client generate --recipe <recipe.json> [...]`.

Given a recipe, drives the full T-0071 pipeline (license gate -> generate
-> save -> descend seam -> provenance) and prints the result as JSON on
stdout -- the shape the `assets` agent (or a caller shelling out) parses
for the output path, not a human-readable report.
"""

from __future__ import annotations

import argparse
import json
import sys

from comfy_client.errors import ComfyClientError
from comfy_client.license_allowlist import CheckpointNotAllowedError
from comfy_client.pipeline import DEFAULT_OUT_DIR, generate
from comfy_client.provenance import provenance_to_dict
from comfy_client.recipe import load_recipe


def _cmd_generate(args: argparse.Namespace) -> int:
    recipe = load_recipe(args.recipe)
    try:
        result = generate(
            recipe,
            out_dir=args.out_dir,
            timeout=args.timeout,
            poll_interval=args.poll_interval,
        )
    except (CheckpointNotAllowedError, ComfyClientError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "path": str(result.path),
                "prompt_id": result.prompt_id,
                "provenance": provenance_to_dict(result.provenance),
            },
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="comfy-client")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("generate", help="generate one image from a recipe JSON file")
    p.add_argument("--recipe", required=True, help="path to a recipe JSON file")
    p.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    p.add_argument("--timeout", type=float, default=300.0)
    p.add_argument("--poll-interval", type=float, default=1.0)
    p.set_defaults(func=_cmd_generate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
