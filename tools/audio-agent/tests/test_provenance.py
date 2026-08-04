"""Provenance seam: model + license + prompt + seed + bus, captured alongside
every generation for the (not-yet-built) ASSET_PROVENANCE.md writer --
conduct.md requires an entry for every generated asset. Mirrors
tools/comfy-client/tests/test_provenance.py, plus D-20 bus coverage."""

from __future__ import annotations

from audio_agent.bus import Bus
from audio_agent.provenance import (
    build_provenance_record,
    build_texture_provenance_record,
    provenance_to_dict,
)
from audio_agent.recipe import MusicRecipe
from audio_agent.texture_recipe import TextureRecipe


def test_build_provenance_record_captures_recipe_fields():
    r = MusicRecipe(prompt="a collapsing hospital ward drone", seed=7, duration=45.0)
    rec = build_provenance_record(r, request_hash="deadbeef", job_id="j1")

    assert rec.model == r.checkpoint
    assert rec.model_license == "Apache-2.0"
    assert rec.prompt == r.prompt
    assert rec.seed == 7
    assert rec.duration == 45.0
    assert rec.bus is Bus.MUSIC
    assert rec.request_hash == "deadbeef"
    assert rec.job_id == "j1"


def test_provenance_to_dict_serializes_bus_as_its_string_value():
    r = MusicRecipe(prompt="x", seed=1)
    rec = build_provenance_record(r, request_hash="h", job_id="j")
    d = provenance_to_dict(rec)
    assert d["bus"] == "Music"
    assert d["prompt"] == "x"
    assert d["request_hash"] == "h"


def test_build_texture_provenance_record_captures_recipe_fields():
    r = TextureRecipe(prompt="a rusted vent grinding", seed=9, seconds=8.0, bus=Bus.AMBIENCE)
    rec = build_texture_provenance_record(r, request_hash="cafebabe", job_id="j2")

    assert rec.model == r.checkpoint
    assert rec.model_license == "Stability AI Community License"
    assert rec.prompt == r.prompt
    assert rec.seed == 9
    assert rec.duration == 8.0
    assert rec.infer_step == r.steps
    assert rec.bus is Bus.AMBIENCE
    assert rec.request_hash == "cafebabe"
    assert rec.job_id == "j2"


def test_texture_provenance_to_dict_serializes_bus_as_its_string_value():
    r = TextureRecipe(prompt="x", seed=1, bus=Bus.GAMEPLAY_SFX)
    rec = build_texture_provenance_record(r, request_hash="h", job_id="j")
    d = provenance_to_dict(rec)
    assert d["bus"] == "Gameplay SFX"
    assert d["prompt"] == "x"
    assert d["request_hash"] == "h"
