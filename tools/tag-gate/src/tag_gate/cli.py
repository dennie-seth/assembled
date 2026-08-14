"""CLI entry point for the tag-gate build check (INV-12).

Usage:
    tag-gate [--hpp PATH] [--variants PATH]

Reads the anchor-tag catalogue from *hpp* (default: shared/note_templates.hpp
relative to the repo root, discovered by walking up from the working directory)
and the variant manifest from *variants* (default: shared/variants.json).

Exit codes:
    0 — no failures (warnings may have been printed)
    1 — one or more variants are missing required tags

If the variant manifest does not exist, there are no variants to check and the
command exits 0 (trivially passing).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

from tag_gate.catalogue import parse_anchor_tags
from tag_gate.checker import check_tag_completeness


def _find_repo_root(start: pathlib.Path) -> pathlib.Path:
    """Walk up from *start* until we find a directory containing shared/."""
    for parent in [start, *start.parents]:
        if (parent / "shared").is_dir():
            return parent
    return start


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="INV-12 build-time anchor-tag completeness check"
    )
    parser.add_argument(
        "--hpp",
        metavar="PATH",
        default=None,
        help="path to shared/note_templates.hpp (default: auto-detected from repo root)",
    )
    parser.add_argument(
        "--variants",
        metavar="PATH",
        default=None,
        help="path to variant manifest JSON (default: shared/variants.json)",
    )
    args = parser.parse_args(argv)

    repo_root = _find_repo_root(pathlib.Path.cwd())

    hpp_path = pathlib.Path(args.hpp) if args.hpp else repo_root / "shared" / "note_templates.hpp"
    variants_path = (
        pathlib.Path(args.variants) if args.variants else repo_root / "shared" / "variants.json"
    )

    # Read catalogue.
    if not hpp_path.exists():
        print(f"ERROR: HPP not found: {hpp_path}", file=sys.stderr)
        return 1
    archetype_tags = parse_anchor_tags(hpp_path.read_text())

    # Read variant manifest — absence means no variants, trivially passing.
    if not variants_path.exists():
        print(f"tag-gate: no variant manifest at {variants_path} — nothing to check")
        return 0

    try:
        manifest = json.loads(variants_path.read_text())
        variants = manifest.get("variants", [])
    except json.JSONDecodeError as exc:
        print(f"ERROR: cannot parse {variants_path}: {exc}", file=sys.stderr)
        return 1

    failures, warnings = check_tag_completeness(archetype_tags, variants)

    for w in warnings:
        print(
            f"WARN  variant {w['variant_id']} (archetype {w['archetype_id']}): "
            f"extra tags {sorted(w['extra_tags'])} not declared by archetype"
        )

    for f in failures:
        print(f"FAIL  {f.reason}")

    if failures:
        print(f"\ntag-gate: {len(failures)} failure(s) — build rejected")
        return 1

    checked = len(variants)
    print(f"tag-gate: {checked} variant(s) checked — all pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
