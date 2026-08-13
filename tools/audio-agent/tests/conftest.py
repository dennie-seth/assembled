"""Shared fixtures: a sample recipe and its rendered request, so client/pipeline
tests don't need to hand-build one."""

from __future__ import annotations

import pytest

from audio_agent.recipe import MusicRecipe
from audio_agent.request import render_request
from audio_agent.texture_recipe import TextureRecipe
from audio_agent.texture_request import render_texture_request


_PROVENANCE_HEADER = (
    "# Asset Provenance\n\n"
    "| Asset | Model | License | Prompt | Seed |\n"
    "|---|---|---|---|---|\n"
)


@pytest.fixture(autouse=True)
def _default_provenance_md(tmp_path, monkeypatch):
    """Create ASSET_PROVENANCE.md in tmp_path and patch CWD so generate() defaults to it.

    Ensures every generate() call writes provenance even when tests don't pass
    provenance_md= explicitly (T-0075: provenance is non-optional).
    """
    (tmp_path / "ASSET_PROVENANCE.md").write_text(_PROVENANCE_HEADER)
    monkeypatch.chdir(tmp_path)


@pytest.fixture
def sample_recipe() -> MusicRecipe:
    return MusicRecipe(
        prompt="somber ambient drone, brutalist concrete hallway", seed=42, name="collapse_bed"
    )


@pytest.fixture
def sample_request(sample_recipe) -> dict:
    return render_request(sample_recipe, output_filename="collapse_bed_test.wav")


@pytest.fixture
def sample_texture_recipe() -> TextureRecipe:
    return TextureRecipe(
        prompt="low mechanical drone, distant ventilation hum, concrete room tone",
        seed=42,
        name="vent_room_tone",
    )


@pytest.fixture
def sample_texture_request(sample_texture_recipe) -> dict:
    return render_texture_request(sample_texture_recipe, output_filename="vent_room_tone_test.wav")
