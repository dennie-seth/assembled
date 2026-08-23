import io

import soundfile as sf

from sfx_synth.pipeline import render_recipe_to_wav_bytes
from sfx_synth.recipes import (
    ALL_RECIPES,
    DOOR,
    FOOTSTEP_CONCRETE,
    FOOTSTEP_RUN,
    FOOTSTEP_WALK,
    ITEM_LEAVE,
    ITEM_PICKUP,
    SWITCH_CLICK,
    TELEGRAPH_SOUND,
    TELEGRAPH_STILL_AIR,
    TELEGRAPH_WATCHER,
)

# T-0101 originals + T-0204 additions.
CATALOG = (
    FOOTSTEP_CONCRETE,
    SWITCH_CLICK,
    DOOR,
    ITEM_PICKUP,
    FOOTSTEP_WALK,
    FOOTSTEP_RUN,
    ITEM_LEAVE,
    TELEGRAPH_WATCHER,
    TELEGRAPH_SOUND,
    TELEGRAPH_STILL_AIR,
)


def test_all_recipes_registry_matches_catalog_names():
    assert set(ALL_RECIPES) == {r.name for r in CATALOG}
    for recipe in CATALOG:
        assert ALL_RECIPES[recipe.name] is recipe


def test_all_recipe_seeds_are_unique():
    seeds = [r.seed for r in CATALOG]
    assert len(seeds) == len(set(seeds))


def test_footstep_is_gameplay_sfx_never_ducked():
    # 13-asset-pipeline.md §4.0: player-noise feedback is the fairness
    # channel P-5 says must never be ducked.
    assert FOOTSTEP_CONCRETE.bus == "gameplay_sfx"


def test_switch_door_pickup_are_world_sfx():
    assert SWITCH_CLICK.bus == "world_sfx"
    assert DOOR.bus == "world_sfx"
    assert ITEM_PICKUP.bus == "world_sfx"


def test_each_recipe_renders_and_lands_within_its_declared_length_bounds():
    for recipe in CATALOG:
        encoded = render_recipe_to_wav_bytes(recipe)
        info = sf.info(io.BytesIO(encoded))
        assert recipe.min_s <= info.duration <= recipe.max_s, (
            f"{recipe.name}: duration {info.duration}s outside "
            f"[{recipe.min_s}, {recipe.max_s}]"
        )


def test_each_recipe_renders_deterministically():
    for recipe in CATALOG:
        a = render_recipe_to_wav_bytes(recipe)
        b = render_recipe_to_wav_bytes(recipe)
        assert a == b, f"{recipe.name} is not deterministic"
