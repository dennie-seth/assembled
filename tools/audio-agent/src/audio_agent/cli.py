"""CLI entrypoints: `audio-agent generate --recipe <recipe.json>` (ACE-Step
music, T-0082) and `audio-agent generate-texture --recipe <recipe.json>`
(Stable Audio Open textures, T-0081).

Given a recipe, each drives the full pipeline (license gate -> generate ->
save -> descend seam -> provenance) and prints the result as JSON on
stdout -- the shape the `audio` agent (or a caller shelling out) parses
for the output path, not a human-readable report. Mirrors `comfy_client.cli`.
"""

from __future__ import annotations

import argparse
import json
import sys

from gen_client_base.license_allowlist import CheckpointNotAllowedError

from audio_agent.errors import AudioClientError
from audio_agent.pipeline import DEFAULT_OUT_DIR, generate, generate_texture
from audio_agent.provenance import provenance_to_dict
from audio_agent.recipe import load_recipe
from audio_agent.texture_recipe import load_texture_recipe


def _cmd_generate(args: argparse.Namespace) -> int:
    recipe = load_recipe(args.recipe)
    try:
        result = generate(
            recipe,
            out_dir=args.out_dir,
            timeout=args.timeout,
            poll_interval=args.poll_interval,
            lock_timeout=args.lock_timeout,
        )
    except (CheckpointNotAllowedError, AudioClientError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "path": str(result.path),
                "job_id": result.job_id,
                "provenance": provenance_to_dict(result.provenance),
            },
            indent=2,
        )
    )
    return 0


def _cmd_generate_texture(args: argparse.Namespace) -> int:
    recipe = load_texture_recipe(args.recipe)
    try:
        result = generate_texture(
            recipe,
            out_dir=args.out_dir,
            timeout=args.timeout,
            poll_interval=args.poll_interval,
            lock_timeout=args.lock_timeout,
        )
    except (CheckpointNotAllowedError, AudioClientError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "path": str(result.path),
                "job_id": result.job_id,
                "provenance": provenance_to_dict(result.provenance),
            },
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="audio-agent")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("generate", help="generate one music cue from a recipe JSON file")
    p.add_argument("--recipe", required=True, help="path to a recipe JSON file")
    p.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    p.add_argument("--timeout", type=float, default=300.0)
    p.add_argument("--poll-interval", type=float, default=1.0)
    p.add_argument(
        "--lock-timeout",
        type=float,
        default=None,
        help="seconds to wait for the GPU lock before giving up (default: wait forever)",
    )
    p.set_defaults(func=_cmd_generate)

    pt = sub.add_parser(
        "generate-texture",
        help="generate one texture SFX (Stable Audio Open) from a recipe JSON file",
    )
    pt.add_argument("--recipe", required=True, help="path to a texture recipe JSON file")
    pt.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    pt.add_argument("--timeout", type=float, default=120.0)
    pt.add_argument("--poll-interval", type=float, default=1.0)
    pt.add_argument(
        "--lock-timeout",
        type=float,
        default=None,
        help="seconds to wait for the GPU lock before giving up (default: wait forever)",
    )
    pt.set_defaults(func=_cmd_generate_texture)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
