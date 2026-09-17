"""Unit tests for ambience_synth.ogg (Ogg encoding + Vorbis comment injection)."""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf


def _sine(freq_hz: float, duration_s: float, amplitude: float = 0.3, sr: int = 44100) -> np.ndarray:
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    return amplitude * np.sin(2 * np.pi * freq_hz * t)


def test_write_ogg_produces_ogg_vorbis_file(tmp_path):
    from ambience_synth.ogg import write_ogg

    out = tmp_path / "test.ogg"
    write_ogg(out, _sine(440, 2.0), sample_rate=44100)
    info = sf.info(str(out))
    assert info.format == "OGG"
    assert info.samplerate == 44100


def test_write_ogg_injects_loop_start_comment(tmp_path):
    from ambience_synth.ogg import write_ogg

    OggVorbis = pytest.importorskip("mutagen.oggvorbis").OggVorbis
    out = tmp_path / "test.ogg"
    write_ogg(out, _sine(440, 2.0), sample_rate=44100, loop_start_sample=0)
    tags = OggVorbis(str(out))
    keys_lower = {k.lower() for k in tags.keys()}
    assert "loop_start" in keys_lower


def test_write_ogg_loop_start_value_is_correct(tmp_path):
    from ambience_synth.ogg import write_ogg

    OggVorbis = pytest.importorskip("mutagen.oggvorbis").OggVorbis
    out = tmp_path / "test.ogg"
    write_ogg(out, _sine(440, 2.0), sample_rate=44100, loop_start_sample=1234)
    tags = OggVorbis(str(out))
    loop_start_vals = [v for k, v in tags.items() if k.lower() == "loop_start"]
    assert loop_start_vals
    val = loop_start_vals[0][0] if isinstance(loop_start_vals[0], list) else loop_start_vals[0]
    assert int(val) == 1234


def test_write_ogg_loop_end_default_is_last_sample(tmp_path):
    from ambience_synth.ogg import write_ogg

    OggVorbis = pytest.importorskip("mutagen.oggvorbis").OggVorbis
    samples = _sine(440, 2.0)
    out = tmp_path / "test.ogg"
    write_ogg(out, samples, sample_rate=44100)
    tags = OggVorbis(str(out))
    loop_end_vals = [v for k, v in tags.items() if k.lower() == "loop_end"]
    assert loop_end_vals
    val = loop_end_vals[0][0] if isinstance(loop_end_vals[0], list) else loop_end_vals[0]
    assert int(val) == len(samples) - 1


def test_write_ogg_decoded_samples_are_audible(tmp_path):
    """Decoded samples have non-trivial amplitude (not silent)."""
    from ambience_synth.ogg import write_ogg

    out = tmp_path / "test.ogg"
    write_ogg(out, _sine(440, 1.0, amplitude=0.3), sample_rate=44100)
    decoded, sr = sf.read(str(out))
    assert sr == 44100
    assert np.max(np.abs(decoded)) > 0.1


def test_write_ogg_creates_parent_directories(tmp_path):
    from ambience_synth.ogg import write_ogg

    nested = tmp_path / "a" / "b" / "c" / "test.ogg"
    write_ogg(nested, _sine(440, 0.5), sample_rate=44100)
    assert nested.exists()
