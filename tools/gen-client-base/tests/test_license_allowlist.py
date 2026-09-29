"""Checkpoint/model license allowlist -- shared guardrail behind both
T-0071's 'refuses to run a workflow whose checkpoint isn't on the
approved-license allowlist' acceptance criterion and T-0082's identical
requirement for ACE-Step. This is that enforced check."""

from __future__ import annotations

import pytest

from gen_client_base.license_allowlist import (
    APPROVED_LICENSE_FAMILIES,
    CheckpointEntry,
    CheckpointNotAllowedError,
    assert_checkpoint_allowed,
    load_allowlist,
)


def test_load_allowlist_reads_the_comfyui_checkpoint_entry():
    allowlist = load_allowlist()
    assert "sd_xl_base_1.0.safetensors" in allowlist
    assert allowlist["sd_xl_base_1.0.safetensors"].license_family == "OpenRAIL"


def test_load_allowlist_reads_the_acestep_entry():
    allowlist = load_allowlist()
    assert "ACE-Step-v1-3.5B" in allowlist
    entry = allowlist["ACE-Step-v1-3.5B"]
    assert entry.license == "Apache-2.0"
    assert entry.license_family == "Apache-2.0"


def test_assert_checkpoint_allowed_passes_for_approved_checkpoint():
    entry = assert_checkpoint_allowed("sd_xl_base_1.0.safetensors")
    assert entry.filename == "sd_xl_base_1.0.safetensors"


def test_assert_checkpoint_allowed_passes_for_approved_acestep_model():
    entry = assert_checkpoint_allowed("ACE-Step-v1-3.5B")
    assert entry.filename == "ACE-Step-v1-3.5B"


def test_load_allowlist_reads_the_stable_audio_open_entry():
    allowlist = load_allowlist()
    assert "stabilityai/stable-audio-open-1.0" in allowlist
    entry = allowlist["stabilityai/stable-audio-open-1.0"]
    assert entry.license == "Stability AI Community License"
    assert entry.license_family == "Stability-Community"


def test_assert_checkpoint_allowed_passes_for_approved_stable_audio_open_model():
    entry = assert_checkpoint_allowed("stabilityai/stable-audio-open-1.0")
    assert entry.filename == "stabilityai/stable-audio-open-1.0"


def test_assert_checkpoint_allowed_rejects_unknown_checkpoint():
    with pytest.raises(CheckpointNotAllowedError, match="not on the approved allowlist"):
        assert_checkpoint_allowed("some_random_checkpoint.safetensors")


def test_assert_checkpoint_allowed_rejects_disallowed_license_family():
    allowlist = {
        "nc_model.safetensors": CheckpointEntry(
            filename="nc_model.safetensors",
            license="CreativeML Open RAIL-M (NC variant)",
            license_family="CC-BY-NC",
        )
    }
    with pytest.raises(CheckpointNotAllowedError, match="license family"):
        assert_checkpoint_allowed("nc_model.safetensors", allowlist=allowlist)


def test_assert_checkpoint_allowed_accepts_injected_allowlist():
    allowlist = {
        "custom.safetensors": CheckpointEntry(
            filename="custom.safetensors", license="Apache-2.0", license_family="Apache-2.0"
        )
    }
    entry = assert_checkpoint_allowed("custom.safetensors", allowlist=allowlist)
    assert entry.license == "Apache-2.0"


def test_sam_is_an_approved_license_family():
    """The SAM License is a fourth approved-with-caveat family (see module docstring)."""
    assert "SAM" in APPROVED_LICENSE_FAMILIES


def test_load_allowlist_reads_the_sam3_entry():
    allowlist = load_allowlist()
    assert "sam3.1_multiplex_fp16.safetensors" in allowlist
    entry = allowlist["sam3.1_multiplex_fp16.safetensors"]
    assert entry.license == "SAM License (2025-11-19)"
    assert entry.license_family == "SAM"


def test_assert_checkpoint_allowed_passes_for_approved_sam3_checkpoint():
    entry = assert_checkpoint_allowed("sam3.1_multiplex_fp16.safetensors")
    assert entry.filename == "sam3.1_multiplex_fp16.safetensors"
    assert entry.license_family == "SAM"
