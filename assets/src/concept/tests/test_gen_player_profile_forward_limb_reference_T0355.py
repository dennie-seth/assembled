"""T-0355 -- forward-limb (near arm + near leg extended ~90 degrees)
green-costume side-profile reference generator, pure construction tests. No
ComfyUI/network dependency (mirrors
test_gen_player_profile_costume_reference_T0317.py's own no-network
graph-construction pattern -- this generator reuses that exact architecture).

Why this generator exists and why it is a pose variant of T-0317's, not a
new architecture: T-0351's own 21-attempt finding is that
side_left_forward/side_right_forward have never once been compliant because
no forward-limb-pose green reference exists anywhere to condition on -- only
T-0317's neutral (arms-down) reference does, which is why T-0351's one
compliant side panel is the one whose target pose (neutral) happens to match
it. This generator is T-0317's own plain-txt2img-plus-style-LoRA stack
(neither ControlNet nor IP-Adapter -- prompt steering has full authority),
with the pose clause changed from standing-neutral to forward-limb walking
and an explicit canonical coat-length constraint added (the exact phrase
already settled project-wide in `gen_master_sheet_T0336.py`'s
`build_single_pose_positive_prompt`: "full-length coat reaching past the
knee").

RED state: gen_player_profile_forward_limb_reference_T0355 does not exist
yet.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

import gen_player_profile_forward_limb_reference_T0355 as gen  # noqa: E402


def _graph(**overrides) -> dict:
    defaults = dict(seed=31700)
    defaults.update(overrides)
    return gen.build_graph(**defaults)


def test_graph_has_no_controlnet_node():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert not any("ControlNet" in ct for ct in class_types), (
        "T-0351's own finding is that per-panel ControlNet-conditioned attempts never "
        "converged on the forward-limb panels -- this generator's whole bet, like T-0317's, "
        "is prompt-only steering with neither ControlNet nor IP-Adapter"
    )


def test_graph_has_no_ipadapter_node():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert not any("IPAdapter" in ct for ct in class_types)


def test_graph_wires_style_lora_between_checkpoint_and_sampler():
    graph = _graph()
    lora = graph[gen.STYLE_LORA_NODE_ID]
    assert lora["class_type"] == "LoraLoader"
    assert lora["inputs"]["model"] == [gen.CHECKPOINT_NODE_ID, 0]
    assert lora["inputs"]["lora_name"] == gen.LORA_NAME
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["model"] == [gen.STYLE_LORA_NODE_ID, 0]


def test_graph_is_1024_square_matching_the_t0209_recipe():
    graph = _graph()
    latent = graph[gen.LATENT_NODE_ID]
    assert latent["inputs"]["width"] == 1024
    assert latent["inputs"]["height"] == 1024


def test_graph_seed_is_threaded_through():
    graph = _graph(seed=99999)
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["seed"] == 99999


def test_positive_prompt_names_the_green_cloth_coat_not_the_tactical_tier():
    prompt = gen.build_positive_prompt()
    assert "green" in prompt.lower()
    assert "coat" in prompt.lower()
    assert "tactical" not in prompt.lower()
    assert not re.search(r"\btan\b", prompt.lower())


def test_positive_prompt_asks_for_a_genuine_side_view():
    prompt = gen.build_positive_prompt()
    assert "side" in prompt.lower()
    assert "front" not in prompt.lower()


def test_positive_prompt_specifies_forward_limb_pose_not_neutral():
    """The card's whole premise: a neutral standing reference (T-0317)
    already exists and has never converged the forward-limb panels -- this
    generator must ask for the near arm AND near leg extended forward, not
    a standing pose."""
    prompt = gen.build_positive_prompt().lower()
    assert "arm" in prompt and "leg" in prompt
    assert "forward" in prompt
    assert "90 degrees" in prompt
    assert prompt.count("90 degrees") >= 2, (
        "both the near arm and the near leg must each carry their own ~90 degree "
        "forward-extension clause, not one shared vague clause"
    )


def test_positive_prompt_states_canonical_coat_length_explicitly():
    """T-0351 attempt 21 saw the coat shorten to mid-thigh with no code
    change touching coat wording -- read as seed variance on an
    unconstrained clause. This card requires the canonical length ('reaching
    past the knee', the exact phrase already settled in
    gen_master_sheet_T0336.py's build_single_pose_positive_prompt) stated
    explicitly, not left implicit."""
    prompt = gen.build_positive_prompt().lower()
    assert "past the knee" in prompt


def test_negative_prompt_forbids_front_facing_and_tactical_costume_drift():
    negative = gen.build_negative_prompt()
    lowered = negative.lower()
    for term in ("front view", "grey tactical", "tan tactical", "khaki"):
        assert term in lowered, f"expected {term!r} in negative prompt"


def test_negative_prompt_forbids_neutral_standing_pose():
    negative = gen.build_negative_prompt().lower()
    assert "neutral standing pose" in negative
    assert "arms at the sides" in negative or "arms hanging down" in negative


def test_negative_prompt_forbids_short_coat_variants():
    negative = gen.build_negative_prompt().lower()
    for term in ("short coat", "mid-thigh coat"):
        assert term in negative, f"expected {term!r} in negative prompt"
