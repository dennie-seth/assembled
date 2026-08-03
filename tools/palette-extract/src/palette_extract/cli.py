"""CLI entrypoint: `palette-extract --sheet <sheet.png> --n 16 --out-dir <dir>
--name home_palette`. Prints the extracted palette (N + hex ordered by
value) as JSON on stdout and writes `<name>.png` (LUT strip) +
`<name>.json` (palette definition) to `--out-dir`."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

from palette_extract.extract import DETERMINISTIC_SEED, extract_palette
from palette_extract.lut import build_lut_image, build_palette_json


def _cmd_extract(args: argparse.Namespace) -> int:
    sheet_path = Path(args.sheet)
    image = Image.open(sheet_path)
    slots = extract_palette(image, n=args.n, seed=args.seed)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    lut_path = out_dir / f"{args.name}.png"
    build_lut_image(slots).save(lut_path)

    source_hash = hashlib.sha256(sheet_path.read_bytes()).hexdigest()
    source = f"{sheet_path.as_posix()} (sha256:{source_hash})"
    json_path = out_dir / f"{args.name}.json"
    json_path.write_text(json.dumps(build_palette_json(slots, source=source), indent=2) + "\n")

    print(
        json.dumps(
            {
                "n": len(slots),
                "lut_png": str(lut_path),
                "palette_json": str(json_path),
                "source": source,
                "slots": [
                    {"index": s.index, "hex": s.hex, "lightness": round(s.lightness, 4)}
                    for s in slots
                ],
            },
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="palette-extract")
    parser.add_argument("--sheet", required=True, help="approved interior concept sheet PNG")
    parser.add_argument("--n", type=int, default=16, help="palette slot count (default: 16)")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--name", default="home_palette")
    parser.add_argument("--seed", type=int, default=DETERMINISTIC_SEED)
    parser.set_defaults(func=_cmd_extract)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
