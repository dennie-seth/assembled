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

Rate limiting: a 44-ref corpus fetched back-to-back with no pacing hits
Wikimedia's rate limit reliably (confirmed live -- see
docs/lora-training-env.md / [[project_assembled_lora_corpus_rebuild]], only
18/44 came through). Every HTTP request (both the imageinfo lookup and the
image download itself) goes through `_request_with_retry`, which retries
429/5xx/network errors with exponential backoff (honouring a `Retry-After`
header when Wikimedia sends one), and `cmd_download` adds a polite fixed
delay between refs so a full run stays under the threshold that triggers
throttling in the first place rather than just recovering from it after
the fact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from lora_train.manifest import Corpus, Ref, load_corpus

_COMMONS_API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia's User-Agent policy (https://meta.wikimedia.org/wiki/User-Agent_policy)
# requires a descriptive client name, version, and real contact info so
# Wikimedia can reach the operator instead of just blocking the IP.
_USER_AGENT = (
    "assembled-lora-fetcher/2.0 "
    "(T-0072 style LoRA training corpus fetcher; "
    "https://github.com/dennie-seth/assembled; "
    "contact: open an issue on the repo above) "
    "Python-urllib"
)

# Retry/backoff tuning for _request_with_retry.
_MAX_RETRIES = 5
_BASE_BACKOFF_SECONDS = 2.0
_MAX_BACKOFF_SECONDS = 60.0

# Polite fixed pause between refs in cmd_download, on top of per-request
# retry backoff -- this is what actually keeps a full 44-ref run under
# Wikimedia's throttling threshold instead of just recovering from it.
_INTER_REF_DELAY_SECONDS = 1.5


def _backoff_delay(attempt: int, retry_after: str | None) -> float:
    """Seconds to wait before retry `attempt` (0-indexed)."""
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass
    delay = min(_BASE_BACKOFF_SECONDS * (2**attempt), _MAX_BACKOFF_SECONDS)
    return delay + random.uniform(0, delay * 0.1)


def _request_with_retry(
    req: urllib.request.Request,
    *,
    timeout: int,
    max_retries: int = _MAX_RETRIES,
) -> bytes:
    """GET `req`, retrying 429/5xx/network errors with exponential backoff."""
    for attempt in range(max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or exc.code >= 500
            if not retryable or attempt >= max_retries:
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            delay = _backoff_delay(attempt, retry_after)
            print(
                f"    [retry {attempt + 1}/{max_retries}] HTTP {exc.code}, "
                f"waiting {delay:.1f}s",
                file=sys.stderr,
            )
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError) as exc:
            # TimeoutError is caught separately from URLError because a
            # read-phase timeout (resp.read() blocking past the socket
            # timeout, as opposed to a connect-phase failure) surfaces as a
            # bare TimeoutError, not wrapped in URLError -- confirmed live
            # during the full 44-ref verification run (ref_025 timed out
            # mid-download and would otherwise have failed on the first try
            # instead of retrying).
            if attempt >= max_retries:
                raise
            delay = _backoff_delay(attempt, None)
            print(
                f"    [retry {attempt + 1}/{max_retries}] {exc}, waiting {delay:.1f}s",
                file=sys.stderr,
            )
            time.sleep(delay)
    raise AssertionError("unreachable: loop above always returns or raises")


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
    data = json.loads(_request_with_retry(req, timeout=30))
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
    data = _request_with_retry(req, timeout=60)
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
    for i, ref in enumerate(corpus.refs):
        if i > 0:
            time.sleep(_INTER_REF_DELAY_SECONDS)
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
