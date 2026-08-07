"""Fetch reference images from Wikimedia Commons.

Downloads the corpus refs defined in corpus.json into assets/src/lora/refs/.
Each image is verified against its declared sha256 (if set in the manifest)
and written alongside a caption .txt file for LoRA training.

Usage:
    python -m lora_train.fetch --download [--corpus corpus.json] [--out refs/]
    python -m lora_train.fetch --verify   [--corpus corpus.json] [--out refs/]

The --download step populates sha256 on first run and prints updated JSON
entries for the operator to commit back to corpus.json. This two-step design
(manifest first, fetch second) keeps the curation record independent of
network availability and lets the corpus be re-fetched deterministically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import urllib.parse
import urllib.request

from lora_train.manifest import Corpus, Ref, load_corpus

_COMMONS_API = "https://commons.wikimedia.org/w/api.php"
_USER_AGENT = (
    "assembled-lora-fetcher/1.0 "
    "(T-0072 style LoRA corpus; https://github.com/dennie-seth/assembled)"
)


def _commons_image_url(commons_file: str) -> str:
    """Resolve a 'File:...' title to its direct URL via the Commons API."""
    title = commons_file  # e.g. "File:Narkomfin_Building_Moscow_2009.jpg"
    params = urllib.parse.urlencode({
        "action": "query",
        "titles": title,
        "prop": "imageinfo",
        "iiprop": "url|size|sha1|extmetadata",
        "iiurlwidth": 2048,
        "format": "json",
    })
    req = urllib.request.Request(
        f"{_COMMONS_API}?{params}",
        headers={"User-Agent": _USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    pages = data["query"]["pages"]
    page = next(iter(pages.values()))
    if "imageinfo" not in page:
        raise FileNotFoundError(f"Commons returned no imageinfo for {title!r}")
    info = page["imageinfo"][0]
    return info["thumburl"] if "thumburl" in info else info["url"]


def _sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _download_one(ref: Ref, out_dir: pathlib.Path) -> tuple[pathlib.Path, str]:
    """Download one ref, return (dest_path, sha256)."""
    ext = pathlib.Path(ref.commons_file.removeprefix("File:")).suffix.lower()
    dest = out_dir / f"{ref.id}{ext}"
    url = _commons_image_url(ref.commons_file)
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return dest, _sha256_file(dest)


def _write_caption(ref: Ref, dest: pathlib.Path) -> None:
    """Write a training caption alongside the image."""
    caption_path = dest.with_suffix(".txt")
    # Short trigger word + concise description for style LoRA conditioning.
    caption = (
        "soviet brutalism style, "
        + ref.curation_notes.split(".")[0].lower().strip()
    )
    caption_path.write_text(caption + "\n", encoding="utf-8")


def cmd_download(corpus: Corpus, out_dir: pathlib.Path) -> int:
    """Download all refs; return exit code."""
    out_dir.mkdir(parents=True, exist_ok=True)
    updated: list[dict] = []
    errors = 0
    for ref in corpus.refs:
        print(f"  {ref.id}  {ref.commons_file}", end=" ... ", flush=True)
        try:
            dest, sha = _download_one(ref, out_dir)
            if ref.sha256 is not None and ref.sha256 != sha:
                print(f"SHA256 MISMATCH (expected {ref.sha256}, got {sha})")
                errors += 1
                continue
            _write_caption(ref, dest)
            print("ok", sha[:12])
            updated.append({
                "id": ref.id,
                "commons_file": ref.commons_file,
                "license": ref.license,
                "attribution": ref.attribution,
                "sha256": sha,
                "curation_notes": ref.curation_notes,
            })
        except Exception as exc:
            print(f"FAILED: {exc}")
            errors += 1
    if updated:
        print(
            "\nUpdated sha256 entries (commit these back to corpus.json):\n"
            + json.dumps(updated, indent=2)
        )
    return 1 if errors else 0


def cmd_verify(corpus: Corpus, out_dir: pathlib.Path) -> int:
    """Verify already-downloaded refs against declared sha256."""
    errors = 0
    for ref in corpus.refs:
        if ref.sha256 is None:
            print(f"  {ref.id}  SKIP (no sha256 in manifest)")
            continue
        ext = pathlib.Path(ref.commons_file.removeprefix("File:")).suffix.lower()
        dest = out_dir / f"{ref.id}{ext}"
        if not dest.exists():
            print(f"  {ref.id}  MISSING {dest}")
            errors += 1
            continue
        actual = _sha256_file(dest)
        if actual != ref.sha256:
            print(f"  {ref.id}  MISMATCH expected={ref.sha256} got={actual}")
            errors += 1
        else:
            print(f"  {ref.id}  ok")
    return 1 if errors else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch LoRA corpus refs")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--download", action="store_true")
    group.add_argument("--verify", action="store_true")
    parser.add_argument(
        "--corpus",
        type=pathlib.Path,
        default=pathlib.Path(__file__).parent.parent.parent.parent / "corpus.json",
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path(__file__).parent.parent.parent.parent / "refs",
    )
    args = parser.parse_args(argv)
    corpus = load_corpus(args.corpus)
    if args.download:
        return cmd_download(corpus, args.out)
    return cmd_verify(corpus, args.out)


if __name__ == "__main__":
    sys.exit(main())
