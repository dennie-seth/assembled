"""Descent-chain handoff seam (T-0073 builds the real chain; T-0071 only
wires the pipeline to call somewhere)."""

from __future__ import annotations

from comfy_client.descend import descend_stub


def test_descend_stub_is_an_identity_passthrough(tmp_path):
    raw = tmp_path / "raw.png"
    raw.write_bytes(b"fake-png-bytes")
    assert descend_stub(raw) == raw
    assert raw.read_bytes() == b"fake-png-bytes"
