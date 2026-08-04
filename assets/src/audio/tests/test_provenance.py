import hashlib
import json

from sfx_synth.provenance import build_provenance_record, provenance_to_dict
from sfx_synth.recipe import Layer, Recipe

LAYER = Layer(
    onset_s=0.0,
    noise_color="white",
    center_hz=200.0,
    q=4.0,
    attack_s=0.005,
    decay_s=0.08,
)

RECIPE = Recipe(
    name="test_sound",
    seed=42,
    bus="gameplay_sfx",
    layers=(LAYER,),
    min_s=0.02,
    max_s=0.5,
)


def test_build_provenance_record_captures_recipe_identity():
    record = build_provenance_record(RECIPE, b"fake wav bytes")
    assert record.name == "test_sound"
    assert record.seed == 42
    assert record.bus == "gameplay_sfx"
    assert record.sample_rate == 44100
    assert record.layer_count == 1


def test_build_provenance_record_has_no_model_no_license_question():
    # P-1/P-3: the recipe is the source, no model, no license question.
    record = build_provenance_record(RECIPE, b"fake wav bytes")
    assert record.method == "deterministic_synthesis"


def test_build_provenance_record_uses_the_recipes_bus_target():
    record = build_provenance_record(RECIPE, b"fake wav bytes")
    assert record.target_lufs == -16.0
    assert record.tolerance_db == 3.0


def test_build_provenance_record_hashes_the_encoded_bytes():
    encoded = b"some encoded wav content"
    record = build_provenance_record(RECIPE, encoded)
    assert record.sha256 == hashlib.sha256(encoded).hexdigest()
    assert record.byte_length == len(encoded)


def test_build_provenance_record_differs_for_different_encoded_bytes():
    a = build_provenance_record(RECIPE, b"one")
    b = build_provenance_record(RECIPE, b"two")
    assert a.sha256 != b.sha256


def test_provenance_to_dict_is_json_serializable():
    record = build_provenance_record(RECIPE, b"fake wav bytes")
    as_dict = provenance_to_dict(record)
    serialized = json.dumps(as_dict)
    assert json.loads(serialized)["name"] == "test_sound"
