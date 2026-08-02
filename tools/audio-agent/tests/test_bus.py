"""Bus enum -- D-20's four values, docs/design/13-asset-pipeline.md §4.1."""

from __future__ import annotations

from audio_agent.bus import Bus


def test_bus_has_exactly_the_four_d20_values():
    assert {b.value for b in Bus} == {"Ambience", "Music", "World SFX", "Gameplay SFX"}


def test_bus_is_a_string_enum_for_json_round_tripping():
    assert Bus.MUSIC == "Music"
    assert Bus("Music") is Bus.MUSIC
