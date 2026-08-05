"""Tests for lora_train.attach — upload corpus refs to the board.

Implements T-0136 acceptance criteria:
  - Each fetched corpus image is uploaded to T-0072 via the board's
    attachments endpoint: POST /api/tasks/T-0072/attachments

Checked against: 13-asset-pipeline.md §3.2
"""

from __future__ import annotations

import urllib.error
import urllib.request
from unittest.mock import MagicMock, patch

import pytest

from lora_train.attach import (
    AttachError,
    attach_all,
    attach_one,
    main,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TINY_PNG = bytes([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,  # PNG magic
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,  # IHDR
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
])

TINY_JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0] + [0x00] * 60)


def _make_ok_response(status: int = 201) -> MagicMock:
    resp = MagicMock()
    resp.status = status
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    resp.read.return_value = b'{"id":"att_001"}'
    return resp


# ---------------------------------------------------------------------------
# attach_one tests
# ---------------------------------------------------------------------------


def test_attach_one_sends_post_to_correct_url(tmp_path):
    img = tmp_path / "ref_001.jpg"
    img.write_bytes(TINY_JPEG)

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        attach_one(img, "http://127.0.0.1:4173", "T-0072", "assets-agent")

    assert mock_open.called
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.full_url == "http://127.0.0.1:4173/api/tasks/T-0072/attachments"
    assert req.get_method() == "POST"


def test_attach_one_sets_multipart_content_type(tmp_path):
    img = tmp_path / "ref_001.png"
    img.write_bytes(TINY_PNG)

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        attach_one(img, "http://127.0.0.1:4173", "T-0072", "assets-agent")

    req: urllib.request.Request = mock_open.call_args[0][0]
    ct = req.get_header("Content-type")
    assert ct is not None
    assert ct.startswith("multipart/form-data; boundary=")


def test_attach_one_body_contains_filename(tmp_path):
    img = tmp_path / "ref_007.jpg"
    img.write_bytes(TINY_JPEG)

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        attach_one(img, "http://127.0.0.1:4173", "T-0072", "assets-agent")

    req: urllib.request.Request = mock_open.call_args[0][0]
    body = req.data
    assert b"ref_007.jpg" in body


def test_attach_one_body_contains_uploaded_by(tmp_path):
    img = tmp_path / "ref_001.png"
    img.write_bytes(TINY_PNG)

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        attach_one(img, "http://127.0.0.1:4173", "T-0072", "assets-agent")

    req: urllib.request.Request = mock_open.call_args[0][0]
    body = req.data
    assert b"assets-agent" in body


def test_attach_one_raises_on_http_error(tmp_path):
    img = tmp_path / "ref_001.png"
    img.write_bytes(TINY_PNG)

    http_err = urllib.error.HTTPError(
        url="http://127.0.0.1:4173/api/tasks/T-0072/attachments",
        code=500,
        msg="Internal Server Error",
        hdrs=None,
        fp=None,
    )
    with patch("urllib.request.urlopen", side_effect=http_err):
        with pytest.raises(AttachError, match="HTTP 500"):
            attach_one(img, "http://127.0.0.1:4173", "T-0072", "assets-agent")


def test_attach_one_raises_on_url_error(tmp_path):
    img = tmp_path / "ref_001.png"
    img.write_bytes(TINY_PNG)

    url_err = urllib.error.URLError(reason="Connection refused")
    with patch("urllib.request.urlopen", side_effect=url_err):
        with pytest.raises(AttachError, match="Connection refused"):
            attach_one(img, "http://127.0.0.1:4173", "T-0072", "assets-agent")


def test_attach_one_raises_if_file_missing(tmp_path):
    missing = tmp_path / "ref_999.png"
    with pytest.raises(FileNotFoundError):
        attach_one(missing, "http://127.0.0.1:4173", "T-0072", "assets-agent")


# ---------------------------------------------------------------------------
# attach_all tests
# ---------------------------------------------------------------------------


def test_attach_all_uploads_each_image(tmp_path):
    (tmp_path / "ref_001.jpg").write_bytes(TINY_JPEG)
    (tmp_path / "ref_002.jpg").write_bytes(TINY_JPEG)
    (tmp_path / "ref_001.txt").write_text("caption one\n")

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        count = attach_all(tmp_path, "http://127.0.0.1:4173", "T-0072", "assets-agent")

    assert count == 2
    assert mock_open.call_count == 2


def test_attach_all_skips_txt_files(tmp_path):
    (tmp_path / "ref_001.jpg").write_bytes(TINY_JPEG)
    (tmp_path / "ref_001.txt").write_text("caption\n")
    (tmp_path / "ref_002.txt").write_text("caption2\n")

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        count = attach_all(tmp_path, "http://127.0.0.1:4173", "T-0072", "assets-agent")

    assert count == 1
    assert mock_open.call_count == 1


def test_attach_all_returns_zero_for_empty_dir(tmp_path):
    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        count = attach_all(tmp_path, "http://127.0.0.1:4173", "T-0072", "assets-agent")

    assert count == 0
    assert mock_open.call_count == 0


def test_attach_all_raises_on_error(tmp_path):
    (tmp_path / "ref_001.jpg").write_bytes(TINY_JPEG)

    http_err = urllib.error.HTTPError(
        url="http://127.0.0.1:4173/api/tasks/T-0072/attachments",
        code=413,
        msg="Payload Too Large",
        hdrs=None,
        fp=None,
    )
    with patch("urllib.request.urlopen", side_effect=http_err):
        with pytest.raises(AttachError):
            attach_all(tmp_path, "http://127.0.0.1:4173", "T-0072", "assets-agent")


# ---------------------------------------------------------------------------
# CLI main() tests
# ---------------------------------------------------------------------------


def test_main_returns_zero_on_success(tmp_path):
    (tmp_path / "ref_001.jpg").write_bytes(TINY_JPEG)

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp):
        rc = main([
            "--refs", str(tmp_path),
            "--board-url", "http://127.0.0.1:4173",
            "--task", "T-0072",
            "--uploaded-by", "assets-agent",
        ])

    assert rc == 0


def test_main_returns_nonzero_on_error(tmp_path):
    (tmp_path / "ref_001.jpg").write_bytes(TINY_JPEG)

    http_err = urllib.error.HTTPError(
        url="http://127.0.0.1:4173/api/tasks/T-0072/attachments",
        code=500,
        msg="Internal Server Error",
        hdrs=None,
        fp=None,
    )
    with patch("urllib.request.urlopen", side_effect=http_err):
        rc = main([
            "--refs", str(tmp_path),
            "--board-url", "http://127.0.0.1:4173",
            "--task", "T-0072",
        ])

    assert rc != 0


def test_main_uses_default_task_and_uploaded_by(tmp_path):
    (tmp_path / "ref_001.jpg").write_bytes(TINY_JPEG)

    resp = _make_ok_response(201)
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        rc = main([
            "--refs", str(tmp_path),
            "--board-url", "http://127.0.0.1:4173",
        ])

    assert rc == 0
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert "/T-0072/" in req.full_url
