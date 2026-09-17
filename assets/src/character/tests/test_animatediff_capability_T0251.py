"""T-0251 capability check: does a usable SDXL motion module exist for
AnimateDiff on the installed ComfyUI host?

HANDOFF §24, handle §24-d. Round 2 of the T-0227 character-pipeline
bake-off (`assets/src/character/BAKEOFF_DECISION_T0231.md`, `docs/decision-log.md`
DL-23). Per this card's own acceptance, the capability check must be recorded
FIRST, before any generation attempt -- these tests validate only the
structural integrity of that decision record, the same pattern
`test_idle_spike_T0218.py` established for the T-0218 method spike. They do
not (and cannot) grade whether the underlying capability finding is
correct -- that requires a human or an independent re-run against the live
ComfyUI host.

RED state:  T-0251-animatediff-capability-decision.json absent -> every test
            below fails on the missing-file assertion.
GREEN state: JSON present, valid, with the fields this card's acceptance
             criteria require regardless of which outcome the check reached.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
DECISION_LOG = (
    REPO_ROOT / "assets" / "src" / "character" / "T-0251-animatediff-capability-decision.json"
)

VALID_OUTCOMES = {"no_usable_motion_module", "usable_motion_module_available"}


def _load() -> dict:
    return json.loads(DECISION_LOG.read_text(encoding="utf-8"))


def test_decision_log_exists() -> None:
    """The capability-check record must exist -- even if it stops the card."""
    assert DECISION_LOG.exists(), (
        f"Decision log not found: {DECISION_LOG}\n"
        "T-0251 requires a JSON capability-check record at this path, per "
        "the card's own acceptance: 'the SDXL motion-module capability "
        "check is performed and recorded FIRST, before any generation "
        "attempt'."
    )


def test_decision_log_valid_json_object() -> None:
    data = _load()
    assert isinstance(data, dict), "decision log must be a JSON object"


def test_outcome_present_and_valid() -> None:
    data = _load()
    assert "outcome" in data, "missing 'outcome' field in decision log"
    assert data["outcome"] in VALID_OUTCOMES, (
        f"outcome {data['outcome']!r} is not one of {sorted(VALID_OUTCOMES)}"
    )


def test_contingency_on_T0248_is_recorded() -> None:
    """The card's own instructions require checking T-0248's outcome before
    spending any attempt here, and saying so plainly if it already solved
    the problem. This must be recorded, not just performed silently."""
    data = _load()
    assert "contingent_on" in data
    contingency = data["contingent_on"]
    assert contingency.get("card") == "T-0248"
    assert "renders_this_card_unnecessary" in contingency
    assert isinstance(contingency["renders_this_card_unnecessary"], bool)
    assert contingency.get("outcome_checked"), (
        "contingent_on.outcome_checked must summarize T-0248's measured result"
    )


def test_capability_check_has_reachability_and_evidence() -> None:
    """The check must be against the real, installed ComfyUI host -- not
    asserted from general knowledge -- and must record multiple pieces of
    corroborating evidence, not a single unverifiable claim."""
    data = _load()
    assert "capability_check" in data
    check = data["capability_check"]
    assert check.get("comfyui_url"), "must record which host was checked"
    assert check.get("reachable") is True
    checks = check.get("checks")
    assert isinstance(checks, list) and len(checks) >= 3, (
        "capability_check.checks must record at least 3 independent pieces "
        "of evidence (e.g. node registry, model-folder registry, model "
        "file listing)"
    )
    for item in checks:
        assert item.get("method"), "each evidence item needs a 'method'"
        assert item.get("result"), "each evidence item needs a 'result'"


def test_conclusion_and_decision_present() -> None:
    data = _load()
    assert data.get("conclusion"), "missing 'conclusion' field"
    assert data.get("decision"), "missing 'decision' field"


def test_no_usable_module_outcome_stops_before_generation() -> None:
    """Per the card's acceptance: 'If no usable SDXL motion module is
    available ... the card stops there'. If that's the recorded outcome,
    the record must not also claim a generated sheet exists, and must not
    record switching the pipeline to SD1.5."""
    data = _load()
    if data["outcome"] != "no_usable_motion_module":
        return
    assert data.get("generation_run") is None, (
        "no_usable_motion_module outcome must not carry a generation_run -- "
        "the card stops at the capability check, per its own acceptance"
    )
    assert data.get("pipeline_model_switched_to_sd1_5") is False, (
        "must not record switching the character pipeline to SD1.5 to "
        "manufacture a pass -- explicitly out of scope for this card, and "
        "this field must be explicitly recorded false, not merely absent"
    )


def test_usable_module_outcome_requires_generation_and_provenance() -> None:
    """The mirror-image branch: if a usable module IS available, the record
    must carry everything the card's acceptance asks for in that case."""
    data = _load()
    if data["outcome"] != "usable_motion_module_available":
        return
    run = data.get("generation_run")
    assert isinstance(run, dict), "usable_motion_module_available requires a generation_run"
    assert run.get("sheet_path"), "generation_run must record the produced sheet path"
    assert run.get("frame_delta_range"), "generation_run must record the measured frame-delta range"
    assert run.get("beats_030_cap") is not None
    assert run.get("beats_arm_c_benchmark") is not None


def test_cost_recorded_not_deciding() -> None:
    """§24.3: cost is recorded, not deciding -- but it must still be recorded."""
    data = _load()
    assert "cost" in data
    cost = data["cost"]
    for key in ("attempts", "gpu_minutes"):
        assert key in cost, f"cost.{key} missing"
