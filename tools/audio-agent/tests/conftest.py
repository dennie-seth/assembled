"""Shared fixtures: a sample recipe and its rendered request, so client/pipeline
tests don't need to hand-build one."""

from __future__ import annotations

import pytest

from audio_agent.recipe import MusicRecipe
from audio_agent.request import render_request


@pytest.fixture
def sample_recipe() -> MusicRecipe:
    return MusicRecipe(
        prompt="somber ambient drone, brutalist concrete hallway", seed=42, name="collapse_bed"
    )


@pytest.fixture
def sample_request(sample_recipe) -> dict:
    return render_request(sample_recipe, output_filename="collapse_bed_test.wav")
