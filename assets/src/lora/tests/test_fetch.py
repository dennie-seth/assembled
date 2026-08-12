"""Tests for lora_train.fetch's retry/backoff logic.

Covers the pure retry/backoff machinery (`_backoff_delay`,
`_request_with_retry`) with `urllib.request.urlopen` mocked out -- actually
hitting the Commons API is exercised by a manual full-corpus fetch run, not
this suite (same pattern as lora_train.train's `accelerate launch` path).
"""

from __future__ import annotations

import io
import urllib.error
import urllib.request

import pytest

from lora_train.fetch import _backoff_delay, _request_with_retry


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def test_backoff_delay_grows_exponentially():
    d0 = _backoff_delay(0, None)
    d1 = _backoff_delay(1, None)
    d2 = _backoff_delay(2, None)
    assert d0 < d1 < d2


def test_backoff_delay_honours_retry_after_header():
    assert _backoff_delay(0, "5") == pytest.approx(5.0)


def test_backoff_delay_ignores_malformed_retry_after():
    delay = _backoff_delay(0, "not-a-number")
    assert delay > 0


def test_backoff_delay_capped_at_max(monkeypatch):
    import lora_train.fetch as fetch_mod

    monkeypatch.setattr(fetch_mod, "_MAX_BACKOFF_SECONDS", 10.0)
    delay = _backoff_delay(20, None)
    assert delay <= 11.0  # cap + jitter headroom


def test_request_with_retry_succeeds_first_try(monkeypatch):
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda req, timeout: _FakeResponse(b"payload")
    )
    req = urllib.request.Request("https://example.invalid")
    assert _request_with_retry(req, timeout=5) == b"payload"


def test_request_with_retry_retries_on_429_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(req, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.HTTPError(
                req.full_url, 429, "Too Many Requests", {}, None
            )
        return _FakeResponse(b"payload")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr("lora_train.fetch.time.sleep", lambda _s: None)
    req = urllib.request.Request("https://example.invalid")
    assert _request_with_retry(req, timeout=5) == b"payload"
    assert calls["n"] == 2


def test_request_with_retry_retries_on_5xx(monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(req, timeout):
        calls["n"] += 1
        if calls["n"] < 3:
            raise urllib.error.HTTPError(
                req.full_url, 503, "Service Unavailable", {}, None
            )
        return _FakeResponse(b"payload")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr("lora_train.fetch.time.sleep", lambda _s: None)
    req = urllib.request.Request("https://example.invalid")
    assert _request_with_retry(req, timeout=5) == b"payload"
    assert calls["n"] == 3


def test_request_with_retry_does_not_retry_on_404(monkeypatch):
    def fake_urlopen(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    req = urllib.request.Request("https://example.invalid")
    with pytest.raises(urllib.error.HTTPError) as exc_info:
        _request_with_retry(req, timeout=5)
    assert exc_info.value.code == 404


def test_request_with_retry_gives_up_after_max_retries(monkeypatch):
    def fake_urlopen(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr("lora_train.fetch.time.sleep", lambda _s: None)
    req = urllib.request.Request("https://example.invalid")
    with pytest.raises(urllib.error.HTTPError):
        _request_with_retry(req, timeout=5, max_retries=2)


def test_request_with_retry_retries_on_bare_timeout_error(monkeypatch):
    """A read-phase timeout surfaces as a bare TimeoutError, not URLError
    (confirmed live: ref_025 in the T-0072 corpus timed out mid-download)."""
    calls = {"n": 0}

    def fake_urlopen(req, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise TimeoutError("The read operation timed out")
        return _FakeResponse(b"payload")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr("lora_train.fetch.time.sleep", lambda _s: None)
    req = urllib.request.Request("https://example.invalid")
    assert _request_with_retry(req, timeout=5) == b"payload"
    assert calls["n"] == 2


def test_request_with_retry_retries_on_url_error(monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(req, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection reset")
        return _FakeResponse(b"payload")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr("lora_train.fetch.time.sleep", lambda _s: None)
    req = urllib.request.Request("https://example.invalid")
    assert _request_with_retry(req, timeout=5) == b"payload"
    assert calls["n"] == 2
