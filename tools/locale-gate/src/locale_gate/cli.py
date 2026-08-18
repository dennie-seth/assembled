"""CLI entry point for the locale-gate build checks (L-1 through L-4).

Usage:
    locale-gate [--hpp PATH] [--seed-cpp PATH] [--locales DIR]

Reads the LocId catalogue from *hpp* (default: shared/note_templates.hpp) and
the seed-phrase wordlist from *seed-cpp* (default: server/src/SeedPhrase.cpp),
then runs L-1 through L-4 against every ``*.po`` file found under *locales*
(default: client/locale/).

Locales with an ``X-Incomplete: true`` header are excluded from L-1 and L-2
but are still checked by L-3 and L-4.

Exit codes:
    0 — all checks passed (warnings may have been printed)
    1 — one or more checks failed
"""

from __future__ import annotations

import argparse
import pathlib
import sys

from locale_gate.catalogue import parse_loc_ids, parse_seed_wordlist, parse_template_slots
from locale_gate.checker import (
    check_l1_coverage,
    check_l2_slot_consistency,
    check_l3_no_positional,
    check_l4_no_seed_words,
)
from locale_gate.po_parser import PoFile, parse_po


def _find_repo_root(start: pathlib.Path) -> pathlib.Path:
    """Walk up from *start* until we find a directory containing shared/."""
    for parent in [start, *start.parents]:
        if (parent / "shared").is_dir():
            return parent
    return start


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="L-1…L-4 build-time localization checks (17-localization.md §3)"
    )
    parser.add_argument(
        "--hpp",
        metavar="PATH",
        default=None,
        help="path to shared/note_templates.hpp (default: auto-detected)",
    )
    parser.add_argument(
        "--seed-cpp",
        metavar="PATH",
        default=None,
        help="path to server/src/SeedPhrase.cpp (default: auto-detected)",
    )
    parser.add_argument(
        "--locales",
        metavar="DIR",
        default=None,
        help="directory containing *.po locale files (default: client/locale/)",
    )
    args = parser.parse_args(argv)

    repo_root = _find_repo_root(pathlib.Path.cwd())

    hpp_path = pathlib.Path(args.hpp) if args.hpp else repo_root / "shared" / "note_templates.hpp"
    seed_cpp_path = (
        pathlib.Path(args.seed_cpp)
        if args.seed_cpp
        else repo_root / "server" / "src" / "SeedPhrase.cpp"
    )
    locale_dir = (
        pathlib.Path(args.locales) if args.locales else repo_root / "client" / "locale"
    )

    # Load catalogue.
    if not hpp_path.exists():
        print(f"ERROR: HPP not found: {hpp_path}", file=sys.stderr)
        return 1
    hpp_text = hpp_path.read_text()
    catalogue_keys = parse_loc_ids(hpp_text)
    template_slots = parse_template_slots(hpp_text)

    # Load seed wordlist.
    if not seed_cpp_path.exists():
        print(f"ERROR: SeedPhrase.cpp not found: {seed_cpp_path}", file=sys.stderr)
        return 1
    seed_words = parse_seed_wordlist(seed_cpp_path.read_text())

    # Load locale .po files.
    locales: dict[str, PoFile] = {}
    if locale_dir.exists():
        for po_file in sorted(locale_dir.glob("*.po")):
            locale_name = po_file.stem
            locales[locale_name] = parse_po(po_file.read_text())

    if not locales:
        print(f"locale-gate: no .po files found under {locale_dir} — nothing to check")
        return 0

    shipped = [name for name, po in locales.items() if not po.is_incomplete]
    incomplete = [name for name, po in locales.items() if po.is_incomplete]
    if incomplete:
        print(f"locale-gate: {len(incomplete)} incomplete locale(s) excluded from L-1/L-2: "
              f"{incomplete}")

    # Run all checks.
    all_failures = (
        check_l1_coverage(catalogue_keys, locales)
        + check_l2_slot_consistency(template_slots, locales)
        + check_l3_no_positional(locales)
        + check_l4_no_seed_words(seed_words, locales)
    )

    for f in all_failures:
        print(f"FAIL [{f.check}] {f.reason}")

    if all_failures:
        print(f"\nlocale-gate: {len(all_failures)} failure(s) — build rejected")
        return 1

    print(f"locale-gate: {len(shipped)} shipped locale(s) checked — all pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
