"""Tests for Godot import preset generation (T-0083).

13-asset-pipeline.md §4.7: Godot import presets ensure consistent audio
settings (loop, bus) across assets landing in assets/final/audio/.
"""

from __future__ import annotations

from audio_agent.godot_preset import GodotAudioPreset, write_godot_import


def test_write_godot_import_creates_import_file(tmp_path):
    """write_godot_import writes a .import file next to the Ogg path."""
    ogg_path = tmp_path / "music.ogg"
    ogg_path.write_bytes(b"")  # placeholder

    preset = GodotAudioPreset(loop=True)
    import_path = write_godot_import(ogg_path, preset)

    assert import_path.exists()
    assert import_path.name == "music.ogg.import"


def test_loopable_preset_has_loop_true(tmp_path):
    """A loopable preset writes loop=true in the [params] section."""
    ogg_path = tmp_path / "ambience.ogg"
    ogg_path.write_bytes(b"")

    import_path = write_godot_import(ogg_path, GodotAudioPreset(loop=True))
    content = import_path.read_text()

    assert "loop=true" in content


def test_nonloopable_preset_has_loop_false(tmp_path):
    """A non-loopable preset writes loop=false in the [params] section."""
    ogg_path = tmp_path / "sfx.ogg"
    ogg_path.write_bytes(b"")

    import_path = write_godot_import(ogg_path, GodotAudioPreset(loop=False))
    content = import_path.read_text()

    assert "loop=false" in content


def test_import_file_contains_remap_section(tmp_path):
    """The generated .import file has a [remap] section with the OGG importer."""
    ogg_path = tmp_path / "music.ogg"
    ogg_path.write_bytes(b"")

    import_path = write_godot_import(ogg_path, GodotAudioPreset(loop=True))
    content = import_path.read_text()

    assert "[remap]" in content
    assert 'importer="AudioStreamOggVorbis"' in content
    assert 'type="AudioStreamOggVorbis"' in content


def test_import_file_contains_params_section(tmp_path):
    """The generated .import file has a [params] section."""
    ogg_path = tmp_path / "music.ogg"
    ogg_path.write_bytes(b"")

    import_path = write_godot_import(ogg_path, GodotAudioPreset())
    content = import_path.read_text()

    assert "[params]" in content


def test_loop_offset_is_written_to_params(tmp_path):
    ogg_path = tmp_path / "music.ogg"
    ogg_path.write_bytes(b"")

    import_path = write_godot_import(ogg_path, GodotAudioPreset(loop=True, loop_offset=512))
    content = import_path.read_text()

    assert "loop_offset=512" in content


def test_write_godot_import_returns_the_import_path(tmp_path):
    """write_godot_import returns the path of the written file."""
    ogg_path = tmp_path / "sfx.ogg"
    ogg_path.write_bytes(b"")

    import_path = write_godot_import(ogg_path, GodotAudioPreset())
    assert import_path == ogg_path.parent / "sfx.ogg.import"


def test_default_preset_has_loop_false():
    """Default GodotAudioPreset has loop=False (safe default for one-shots)."""
    preset = GodotAudioPreset()
    assert preset.loop is False
