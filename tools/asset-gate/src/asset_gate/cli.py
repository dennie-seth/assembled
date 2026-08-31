"""CLI entry point: `asset-gate <subcommand> ...`.

Every subcommand prints a PASS/FAIL report (`result.format_report`) and
exits 0 if every check passed, 1 otherwise -- the shape CI needs.
"""

from __future__ import annotations

import argparse
import json
import sys

import soundfile as sf
from PIL import Image

from asset_gate import art, audio
from asset_gate import character as character_mod
from asset_gate import generator as generator_mod
from asset_gate import palette as palette_mod
from asset_gate import provenance as provenance_mod
from asset_gate import transparency as transparency_mod
from asset_gate import visibility as visibility_mod
from asset_gate.result import CheckResult, all_passed, format_report


def _report_and_exit(results: list[CheckResult]) -> int:
    print(format_report(results))
    return 0 if all_passed(results) else 1


def _cmd_art_palette(args: argparse.Namespace) -> int:
    image = Image.open(args.image)
    pal = palette_mod.load_palette(args.palette)
    results = [
        palette_mod.check_palette_membership(image, pal),
        palette_mod.check_index_semantics(image, pal),
    ]
    return _report_and_exit(results)


def _cmd_art_tile_seam(args: argparse.Namespace) -> int:
    image = Image.open(args.image)
    return _report_and_exit([art.check_tile_seamlessness(image)])


def _cmd_art_orphan_pixels(args: argparse.Namespace) -> int:
    image = Image.open(args.image)
    result = art.check_orphan_pixels(image, args.background_index, args.size_threshold)
    return _report_and_exit([result])


def _cmd_art_indexed_preservation(args: argparse.Namespace) -> int:
    image = Image.open(args.image)
    pal = palette_mod.load_palette(args.palette)
    return _report_and_exit([art.check_indexed_preservation(image, pal)])


def _cmd_provenance_model_hash(args: argparse.Namespace) -> int:
    prov = json.loads(args.provenance.read())
    return _report_and_exit([provenance_mod.check_provenance_model_hash(prov)])


def _cmd_provenance_sweep(args: argparse.Namespace) -> int:
    baseline = provenance_mod.load_baseline()
    results = provenance_mod.sweep_provenance_model_hash(args.root, baseline=baseline)
    if not results:
        print(f"no *.provenance.json files found under {args.root}")
    return _report_and_exit(results)


def _cmd_generator_sweep(args: argparse.Namespace) -> int:
    baseline = generator_mod.load_generator_baseline()
    results = generator_mod.sweep_provenance_generator_resolvable(
        args.root, repo_root=args.repo_root, baseline=baseline
    )
    if not results:
        print(f"no *.provenance.json files found under {args.root}")
    return _report_and_exit(results)


def _cmd_generator_hash_sweep(args: argparse.Namespace) -> int:
    results = generator_mod.sweep_generator_hash_matches(args.root, repo_root=args.repo_root)
    if not results:
        print(f"no *.provenance.json files found under {args.root}")
    return _report_and_exit(results)


def _cmd_character_arm_c_sweep(args: argparse.Namespace) -> int:
    baseline = character_mod.load_character_arm_c_baseline()
    results = character_mod.sweep_character_arm_c_provenance(args.root, baseline=baseline)
    if not results:
        print(f"no *.provenance.json files found under {args.root}")
    return _report_and_exit(results)


def _cmd_art_visibility(args: argparse.Namespace) -> int:
    image = Image.open(args.image)
    result = visibility_mod.check_rendered_visibility(
        image, min_visible_colors=args.min_visible_colors
    )
    return _report_and_exit([result])


def _cmd_art_transparency(args: argparse.Namespace) -> int:
    image = Image.open(args.image)
    return _report_and_exit([transparency_mod.check_background_transparency(image)])


def _cmd_transparency_sweep(args: argparse.Namespace) -> int:
    baseline = transparency_mod.load_transparency_baseline()
    results = transparency_mod.sweep_sprite_transparency(args.root, baseline=baseline)
    if not results:
        print(f"no *.png files found under {args.root}")
    return _report_and_exit(results)


def _cmd_visibility_sweep(args: argparse.Namespace) -> int:
    results = visibility_mod.sweep_rendered_visibility(
        args.root, min_visible_colors=args.min_visible_colors
    )
    if not results:
        print(f"no *.png files found under {args.root}")
    return _report_and_exit(results)


def _cmd_audio_gate(args: argparse.Namespace) -> int:
    samples, sample_rate = sf.read(args.audio, always_2d=False)
    targets = audio.load_loudness_targets(args.loudness_targets)
    results = [
        audio.check_loop_seam(samples, sample_rate, threshold=args.seam_threshold),
        audio.check_integrated_loudness(samples, sample_rate, bus=args.bus, targets=targets),
        audio.check_true_peak(samples, max_dbtp=args.max_dbtp),
        audio.check_length_bounds(len(samples) / sample_rate, args.min_s, args.max_s),
        audio.check_silence_trimmed(samples, sample_rate),
        audio.check_dc_offset(samples),
    ]
    return _report_and_exit(results)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="asset-gate")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser(
        "provenance-model-hash",
        help="validate model_hash is present and non-null in a provenance sidecar (T-0151)",
    )
    p.add_argument("provenance", type=argparse.FileType("r"), help=".provenance.json path")
    p.set_defaults(func=_cmd_provenance_model_hash)

    p = sub.add_parser(
        "provenance-sweep",
        help=(
            "recursively validate model_hash in every *.provenance.json under "
            "a directory (T-0151/HANDOFF §21 -- catches gaps in any writer)"
        ),
    )
    p.add_argument("root", help="directory to search recursively (e.g. assets/)")
    p.set_defaults(func=_cmd_provenance_sweep)

    p = sub.add_parser(
        "generator-sweep",
        help=(
            "recursively validate that the generator field in every *.provenance.json "
            "resolves to a committed repo file (T-0219/HANDOFF §22-c)"
        ),
    )
    p.add_argument("root", help="directory to search recursively (e.g. assets/)")
    p.add_argument(
        "--repo-root",
        default=".",
        help="repository root used to resolve generator paths (default: current directory)",
    )
    p.set_defaults(func=_cmd_generator_sweep)

    p = sub.add_parser(
        "generator-hash-sweep",
        help=(
            "recursively validate that the generator_hash field in every "
            "*.provenance.json (where present) matches the actual sha256 of its "
            "generator file (T-0238 -- catches fabricated/stale hashes)"
        ),
    )
    p.add_argument("root", help="directory to search recursively (e.g. assets/)")
    p.add_argument(
        "--repo-root",
        default=".",
        help="repository root used to resolve generator paths (default: current directory)",
    )
    p.set_defaults(func=_cmd_generator_hash_sweep)

    p = sub.add_parser(
        "character-arm-c-sweep",
        help=(
            "recursively validate that every character-class *.provenance.json under "
            "a directory records frame_delta_range + the Arm-C benchmark comparison "
            "(docs/board-invariants.md CHR-1, T-0258)"
        ),
    )
    p.add_argument(
        "root", help="directory whose subdirectories are asset classes (e.g. assets/final)"
    )
    p.set_defaults(func=_cmd_character_arm_c_sweep)

    p = sub.add_parser("art-palette", help="palette membership + index semantics (P-4)")
    p.add_argument("image")
    p.add_argument("--palette", required=True)
    p.set_defaults(func=_cmd_art_palette)

    p = sub.add_parser("art-tile-seam", help="tile seamlessness")
    p.add_argument("image")
    p.set_defaults(func=_cmd_art_tile_seam)

    p = sub.add_parser("art-orphan-pixels", help="orphan-pixel check")
    p.add_argument("image")
    p.add_argument("--background-index", type=int, default=0)
    p.add_argument("--size-threshold", type=int, required=True)
    p.set_defaults(func=_cmd_art_orphan_pixels)

    p = sub.add_parser("art-indexed-preservation", help="mode 'P' + palette preserved")
    p.add_argument("image")
    p.add_argument("--palette", required=True)
    p.set_defaults(func=_cmd_art_indexed_preservation)

    p = sub.add_parser(
        "art-visibility",
        help="reject a fully-transparent or blank/uniform image (T-0215 alpha-zero bug)",
    )
    p.add_argument("image")
    p.add_argument("--min-visible-colors", type=int, default=3)
    p.set_defaults(func=_cmd_art_visibility)

    p = sub.add_parser(
        "visibility-sweep",
        help=(
            "recursively reject any fully-transparent or blank/uniform *.png "
            "under a directory (e.g. assets/final -- catches PR #231-style regressions)"
        ),
    )
    p.add_argument("root", help="directory to search recursively (e.g. assets/final)")
    p.add_argument("--min-visible-colors", type=int, default=3)
    p.set_defaults(func=_cmd_visibility_sweep)

    p = sub.add_parser(
        "art-transparency",
        help="reject a sprite whose background is opaque (P-6, the T-0252 §24-e bug)",
    )
    p.add_argument("image")
    p.set_defaults(func=_cmd_art_transparency)

    p = sub.add_parser(
        "transparency-sweep",
        help=(
            "recursively reject any sprite *.png under a directory whose background "
            "is opaque (e.g. assets/final -- tiles and the palette LUT are exempt "
            "by asset class, documented exceptions live in transparency_baseline.txt)"
        ),
    )
    p.add_argument("root", help="directory to search recursively (e.g. assets/final)")
    p.set_defaults(func=_cmd_transparency_sweep)

    p = sub.add_parser("audio-gate", help="run the standard single-file audio checks")
    p.add_argument("audio")
    p.add_argument(
        "--bus", required=True, choices=["ambience", "music", "world_sfx", "gameplay_sfx"]
    )
    p.add_argument("--loudness-targets", required=True)
    p.add_argument("--seam-threshold", type=float, default=0.01)
    p.add_argument("--max-dbtp", type=float, default=-1.0)
    p.add_argument("--min-s", type=float, default=0.0)
    p.add_argument("--max-s", type=float, default=3600.0)
    p.set_defaults(func=_cmd_audio_gate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
