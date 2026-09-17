"""Validate the committed encoded artifact: assets/final/audio/signal_tower_ambience.ogg.

T-0202 acceptance criterion: ENCODED output file validated (not just the source).
This test suite runs against the actual Ogg file on disk — not against the
synthesis source or intermediate samples. It FAILs intentionally on the RED
commit because the artifact does not yet exist. The pipeline produces it; then
this suite goes GREEN, which is the evidence the acceptance criterion is met.

`13-asset-pipeline.md §4.7`: validate ON THE ENCODED FILE — Ogg Vorbis encoder
padding can introduce a seam that was clean before encoding, so a check that
only runs pre-encode can pass a file that clicks in-engine.
"""

from __future__ import annotations

import pathlib

import numpy as np
import pytest
import soundfile as sf

# ── path to the committed artifact ─────────────────────────────────────────────
# __file__ is at  assets/src/ambience_synth/tests/test_...py
# parents[0]       assets/src/ambience_synth/tests/
# parents[1]       assets/src/ambience_synth/
# parents[2]       assets/src/
# parents[3]       assets/
# parents[4]       worktree root
WORKTREE_ROOT = pathlib.Path(__file__).resolve().parents[4]
OGG_PATH = WORKTREE_ROOT / "assets" / "final" / "audio" / "signal_tower_ambience.ogg"

_LOOP_SEAM_THRESHOLD = 0.10  # max start/end amplitude delta for a clean loop
_LUFS_TARGET = -23.0
_LUFS_TOLERANCE = 2.0  # ambience bus placeholder target (AU-2 pending)
_MAX_DBTP = -1.0  # true-peak ceiling (13-asset-pipeline.md §4.8)
_MIN_DURATION_S = 20.0  # ambience bed must be long enough to not feel abrupt
_MAX_DURATION_S = 120.0  # upper sanity bound


# ── fail-fast existence check ───────────────────────────────────────────────────

def test_encoded_ogg_file_exists():
    """The artifact must exist on disk before any other check is meaningful.

    This is the RED test — it fails on the initial commit and goes GREEN once
    the pipeline has been run and its output committed.
    """
    assert OGG_PATH.exists(), (
        f"T-0202 encoded artifact missing: {OGG_PATH}\n"
        "Run the pipeline to generate it:\n"
        "  cd assets/src/ambience_synth\n"
        "  python -m ambience_synth.pipeline"
    )


# ── fixture: load the decoded samples once per session ─────────────────────────

@pytest.fixture(scope="module")
def ogg_decoded():
    """Decoded float64 samples + sample_rate from the committed Ogg file."""
    if not OGG_PATH.exists():
        pytest.skip("artifact not generated yet — run test_encoded_ogg_file_exists first")
    samples, sr = sf.read(str(OGG_PATH), dtype="float64", always_2d=False)
    return samples, sr


@pytest.fixture(scope="module")
def ogg_info():
    if not OGG_PATH.exists():
        pytest.skip("artifact not generated yet")
    return sf.info(str(OGG_PATH))


# ── format checks ───────────────────────────────────────────────────────────────

def test_encoded_ogg_is_ogg_vorbis(ogg_info):
    """File must be Ogg Vorbis (not WAV, FLAC, etc.) — 13-asset-pipeline.md §4.7."""
    assert ogg_info.format == "OGG", f"expected OGG format, got {ogg_info.format}"


def test_encoded_ogg_sample_rate_is_44100(ogg_info):
    assert ogg_info.samplerate == 44100, (
        f"expected 44100 Hz, got {ogg_info.samplerate}"
    )


def test_encoded_ogg_duration_within_bounds(ogg_decoded):
    samples, sr = ogg_decoded
    duration_s = len(samples) / sr
    assert _MIN_DURATION_S <= duration_s <= _MAX_DURATION_S, (
        f"duration {duration_s:.1f}s outside [{_MIN_DURATION_S}, {_MAX_DURATION_S}]s"
    )


# ── loop seam check (THE key T-0083 requirement) ───────────────────────────────

def test_encoded_ogg_loop_seam_passes(ogg_decoded):
    """Loop seam evaluated on the DECODED Ogg, not the pre-encode source.

    Ogg Vorbis encoder padding can break a seam that was clean in the WAV
    source (13-asset-pipeline.md §4.7). This check validates the shipped
    artifact, mirroring asset_gate.audio.check_loop_seam.
    """
    samples, sr = ogg_decoded
    mono = samples if samples.ndim == 1 else samples.mean(axis=1)
    window = 32
    n = min(window, len(mono) // 2)
    start_window = mono[:n]
    end_window = mono[-n:]
    max_diff = float(np.max(np.abs(start_window - end_window)))
    assert max_diff <= _LOOP_SEAM_THRESHOLD, (
        f"loop seam check on encoded Ogg failed: max start/end delta "
        f"{max_diff:.5f} > threshold {_LOOP_SEAM_THRESHOLD}. "
        f"Ogg encoder padding may have broken the loop-fold seam."
    )


# ── loudness check ──────────────────────────────────────────────────────────────

def test_encoded_ogg_loudness_within_ambience_target(ogg_decoded):
    """EBU R128 integrated loudness must hit ambience bus target (-23 ± 2 LUFS).

    Measured on the decoded Ogg (not the pre-encode WAV).
    Placeholder target pending AU-2 (see loudness_targets.placeholder.json).
    """
    pyln = pytest.importorskip("pyloudnorm")
    samples, sr = ogg_decoded
    meter = pyln.Meter(sr, block_size=0.4)
    measured = float(meter.integrated_loudness(samples.astype(np.float64)))
    assert np.isfinite(measured), "loudness measurement returned -inf (silent file?)"
    delta = abs(measured - _LUFS_TARGET)
    assert delta <= _LUFS_TOLERANCE, (
        f"loudness {measured:.2f} LUFS outside target "
        f"{_LUFS_TARGET} ± {_LUFS_TOLERANCE} LUFS"
    )


# ── true peak check ─────────────────────────────────────────────────────────────

def test_encoded_ogg_true_peak_within_ceiling(ogg_decoded):
    """True peak (4× oversampled inter-sample peak) ≤ -1 dBTP."""
    resample_poly = pytest.importorskip("scipy.signal").resample_poly
    samples, sr = ogg_decoded
    mono = samples if samples.ndim == 1 else samples.mean(axis=1)
    oversampled = resample_poly(mono.astype(np.float64), up=4, down=1)
    peak = float(np.max(np.abs(oversampled))) if len(oversampled) else 0.0
    peak_dbtp = 20.0 * np.log10(peak) if peak > 0 else float("-inf")
    assert peak_dbtp <= _MAX_DBTP, (
        f"true peak {peak_dbtp:.2f} dBTP exceeds ceiling {_MAX_DBTP} dBTP"
    )


# ── loop metadata check ─────────────────────────────────────────────────────────

def test_encoded_ogg_has_loop_start_vorbis_comment():
    """Ogg file must carry a LOOP_START Vorbis comment for Godot's loop offset.

    Godot reads this comment to set the explicit loop point for streamed audio.
    Requires mutagen — skips if not installed (but CI must have it).
    """
    if not OGG_PATH.exists():
        pytest.skip("artifact not generated yet")
    OggVorbis = pytest.importorskip("mutagen.oggvorbis").OggVorbis
    tags = OggVorbis(str(OGG_PATH))
    keys_lower = {k.lower() for k in tags.keys()}
    assert "loop_start" in keys_lower, (
        f"LOOP_START Vorbis comment missing from {OGG_PATH.name}. "
        "Godot requires this for explicit loop offset."
    )


def test_encoded_ogg_loop_start_is_valid_integer():
    """LOOP_START value must be a non-negative integer sample offset."""
    if not OGG_PATH.exists():
        pytest.skip("artifact not generated yet")
    OggVorbis = pytest.importorskip("mutagen.oggvorbis").OggVorbis
    tags = OggVorbis(str(OGG_PATH))
    loop_start_values = [v for k, v in tags.items() if k.lower() == "loop_start"]
    assert loop_start_values, "LOOP_START not found"
    first = loop_start_values[0]
    raw = first[0] if isinstance(first, list) else first
    sample_offset = int(raw)
    assert sample_offset >= 0, f"LOOP_START must be >= 0, got {sample_offset}"


# ── DC offset check ─────────────────────────────────────────────────────────────

def test_encoded_ogg_dc_offset_is_near_zero(ogg_decoded):
    """DC offset (mean) must be approximately zero after encode."""
    samples, sr = ogg_decoded
    mono = samples if samples.ndim == 1 else samples.mean(axis=1)
    offset = float(np.mean(mono))
    assert abs(offset) <= 1e-2, f"DC offset {offset:.6f} exceeds 0.01 threshold"
