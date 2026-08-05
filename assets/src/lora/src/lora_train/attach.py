"""Upload fetched corpus reference images to the board task attachments.

For each image file in refs/, POSTs it to the board's attachments endpoint:
    POST /api/tasks/<task_id>/attachments  (multipart/form-data)
      file=<image bytes>  (filename preserved)
      uploaded_by=<agent name>

Usage:
    python -m lora_train.attach [--refs refs/] [--board-url http://127.0.0.1:4173]
                                [--task T-0072] [--uploaded-by assets-agent]
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import urllib.error
import urllib.request
import uuid


# File extensions that are image data and should be uploaded.
# .txt caption files that live alongside images are excluded.
_SKIP_SUFFIXES = frozenset({".txt"})


class AttachError(RuntimeError):
    """Raised when an upload to the board fails."""


def _build_multipart(
    filename: str,
    data: bytes,
    content_type: str,
    uploaded_by: str,
) -> tuple[bytes, str]:
    """Build a multipart/form-data body with 'file' and 'uploaded_by' fields."""
    boundary = uuid.uuid4().hex
    crlf = b"\r\n"

    def field(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n'
            f"\r\n"
            f"{value}\r\n"
        ).encode()

    file_header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n"
        f"\r\n"
    ).encode()

    body = (
        field("uploaded_by", uploaded_by)
        + file_header
        + data
        + crlf
        + f"--{boundary}--\r\n".encode()
    )
    return body, f"multipart/form-data; boundary={boundary}"


def _mime_for(path: pathlib.Path) -> str:
    """Return a MIME type from the file extension (best-effort)."""
    ext = path.suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(ext, "application/octet-stream")


def attach_one(
    path: pathlib.Path,
    board_url: str,
    task_id: str,
    uploaded_by: str,
) -> None:
    """Upload a single file to the board as an attachment on task_id.

    Raises FileNotFoundError if path does not exist.
    Raises AttachError on HTTP or network failure.
    """
    path = pathlib.Path(path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    data = path.read_bytes()
    mime = _mime_for(path)
    body, content_type = _build_multipart(path.name, data, mime, uploaded_by)

    url = f"{board_url.rstrip('/')}/api/tasks/{task_id}/attachments"
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": content_type},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60):
            pass
    except urllib.error.HTTPError as exc:
        raise AttachError(f"HTTP {exc.code} uploading {path.name}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise AttachError(f"Upload failed for {path.name}: {exc.reason}") from exc


def attach_all(
    refs_dir: pathlib.Path,
    board_url: str,
    task_id: str,
    uploaded_by: str,
) -> int:
    """Upload all image files in refs_dir. Returns the count of uploaded files.

    Raises AttachError on the first upload failure.
    """
    refs_dir = pathlib.Path(refs_dir)
    count = 0
    for entry in sorted(refs_dir.iterdir()):
        if not entry.is_file():
            continue
        if entry.suffix.lower() in _SKIP_SUFFIXES:
            continue
        print(f"  uploading {entry.name} ...", end=" ", flush=True)
        attach_one(entry, board_url, task_id, uploaded_by)
        print("ok")
        count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Upload fetched LoRA corpus images to the board task."
    )
    parser.add_argument(
        "--refs",
        type=pathlib.Path,
        default=pathlib.Path(__file__).parent.parent.parent.parent / "refs",
        help="Directory containing downloaded ref images (default: refs/)",
    )
    parser.add_argument(
        "--board-url",
        default="http://127.0.0.1:4173",
        help="Board server base URL (default: http://127.0.0.1:4173)",
    )
    parser.add_argument(
        "--task",
        default="T-0072",
        help="Board task ID to attach images to (default: T-0072)",
    )
    parser.add_argument(
        "--uploaded-by",
        default="assets-agent",
        help="uploaded_by field value (default: assets-agent)",
    )
    args = parser.parse_args(argv)

    if not args.refs.exists():
        print(f"refs dir not found: {args.refs}", file=sys.stderr)
        return 1

    try:
        count = attach_all(args.refs, args.board_url, args.task, args.uploaded_by)
        print(f"\nUploaded {count} file(s) to {args.task}.")
        return 0
    except AttachError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
