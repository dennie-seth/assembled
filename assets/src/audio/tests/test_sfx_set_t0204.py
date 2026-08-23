"""T-0204: One-shot SFX set — failing tests, committed before implementation (TDD red).

New recipes required by HANDOFF §20-c3:
  footstep_walk (distinct from run), footstep_run (distinct from walk),
  item_leave, telegraph_watcher, telegraph_sound, telegraph_still_air.

Acceptance criteria:
  1. Same seed produces a byte-identical WAV (determinism).
  2. Entity telegraphs are on gameplay_sfx (fairness channel P-5, never ducked).
"""

from __future__ import annotations

import io

import soundfile as sf

from sfx_synth.pipeline import render_recipe_to_wav_bytes
from sfx_synth.recipes import ALL_RECIPES

# ── helpers ────────────────────────────────────────────────────────────────────

NEW_RECIPE_NAMES = (
    "footstep_walk",
    "footstep_run",
    "item_leave",
    "telegraph_watcher",
    "telegraph_sound",
    "telegraph_still_air",
)

TELEGRAPH_NAMES = ("telegraph_watcher", "telegraph_sound", "telegraph_still_air")

# ── catalog / registry ─────────────────────────────────────────────────────────


def test_all_new_recipes_registered_in_all_recipes():
    """Every T-0204 recipe must be in the ALL_RECIPES registry."""
    for name in NEW_RECIPE_NAMES:
        assert name in ALL_RECIPES, f"{name!r} missing from ALL_RECIPES"


def test_new_recipe_registry_entries_are_the_canonical_objects():
    for name in NEW_RECIPE_NAMES:
        recipe = ALL_RECIPES[name]
        assert recipe.name == name


def test_all_recipe_seeds_remain_unique_after_t0204():
    seeds = [r.seed for r in ALL_RECIPES.values()]
    assert len(seeds) == len(set(seeds)), "seed collision after T-0204 additions"


# ── bus assignment / fairness channel ──────────────────────────────────────────


def test_footstep_walk_is_gameplay_sfx_never_ducked():
    """Player-noise feedback is fairness channel P-5 (13-asset-pipeline.md §4.0)."""
    assert ALL_RECIPES["footstep_walk"].bus == "gameplay_sfx"


def test_footstep_run_is_gameplay_sfx_never_ducked():
    assert ALL_RECIPES["footstep_run"].bus == "gameplay_sfx"


def test_item_leave_is_world_sfx():
    """Item-leave is environment/interaction feedback, not the fairness channel."""
    assert ALL_RECIPES["item_leave"].bus == "world_sfx"


def test_all_telegraph_recipes_are_gameplay_sfx_never_ducked():
    """Entity telegraphs are the detection-warning fairness channel P-5.

    They must *never* be ducked -- a player who cannot hear a detection
    telegraph loses the fairness guarantee the system depends on.
    13-asset-pipeline.md §4.0, HANDOFF §20-c3.
    """
    for name in TELEGRAPH_NAMES:
        recipe = ALL_RECIPES[name]
        assert recipe.bus == "gameplay_sfx", (
            f"{name!r} must be gameplay_sfx (never ducked); got {recipe.bus!r}"
        )


# ── walk / run distinction ─────────────────────────────────────────────────────


def test_footstep_walk_and_run_have_distinct_seeds():
    """Two distinct recipes must have distinct seeds -- else they produce identical bytes."""
    walk = ALL_RECIPES["footstep_walk"]
    run = ALL_RECIPES["footstep_run"]
    assert walk.seed != run.seed


def test_footstep_walk_and_run_produce_distinct_wav_bytes():
    walk_wav = render_recipe_to_wav_bytes(ALL_RECIPES["footstep_walk"])
    run_wav = render_recipe_to_wav_bytes(ALL_RECIPES["footstep_run"])
    assert walk_wav != run_wav, "walk and run produced identical bytes — not distinct"


# ── length bounds ──────────────────────────────────────────────────────────────


def test_new_recipes_render_within_declared_length_bounds():
    for name in NEW_RECIPE_NAMES:
        recipe = ALL_RECIPES[name]
        encoded = render_recipe_to_wav_bytes(recipe)
        info = sf.info(io.BytesIO(encoded))
        assert recipe.min_s <= info.duration <= recipe.max_s, (
            f"{name}: duration {info.duration:.4f}s outside [{recipe.min_s}, {recipe.max_s}]"
        )


# ── determinism ────────────────────────────────────────────────────────────────


def test_new_recipes_render_deterministically():
    """Same seed must produce byte-identical WAV output (T-0204 AC §1)."""
    for name in NEW_RECIPE_NAMES:
        a = render_recipe_to_wav_bytes(ALL_RECIPES[name])
        b = render_recipe_to_wav_bytes(ALL_RECIPES[name])
        assert a == b, f"{name!r} is not deterministic: two renders differ"


# ── telegraph distinctness ─────────────────────────────────────────────────────


def test_each_telegraph_sensor_type_produces_distinct_bytes():
    """Watcher / Sound / Still Air must sound different -- they are distinct entities."""
    wavs = {name: render_recipe_to_wav_bytes(ALL_RECIPES[name]) for name in TELEGRAPH_NAMES}
    names = list(TELEGRAPH_NAMES)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            assert wavs[a] != wavs[b], f"{a!r} and {b!r} produced identical bytes"
