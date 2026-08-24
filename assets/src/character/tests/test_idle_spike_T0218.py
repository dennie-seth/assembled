"""T-0218 spike: decision-log artifact validation.

Verifies that the method spike (player idle sheet generation + game-scale
comparison) produced a structured decision-log artifact — even if the spike
could not run (NOT_RUN outcome due to blocked prerequisites).

docs/design/13-asset-pipeline.md §3.5 — Characters: the hard class.
HANDOFF §22.2 — this spike decides whether to commit to four per-character LoRAs.

RED state:  T-0218-spike-decision.json absent → test_decision_log_exists fails.
GREEN state: JSON present with outcome in the valid set; NOT_RUN has a reason.

NOTE: This file intentionally does NOT test generation quality — that requires
a human eyeballing the output at 40px game scale. These tests verify only the
structural integrity of the decision artifact so the reviewer's machine gate
has something concrete to check.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
DECISION_LOG = (
    REPO_ROOT / "assets" / "src" / "character" / "T-0218-spike-decision.json"
)

VALID_OUTCOMES = {"generation_wins", "generation_loses", "ambiguous", "NOT_RUN"}


def test_decision_log_exists() -> None:
    """Spike must produce a decision log — even if NOT_RUN."""
    assert DECISION_LOG.exists(), (
        f"Decision log not found: {DECISION_LOG}\n"
        "T-0218 requires a JSON decision log at this path, recording the "
        "spike outcome (generation_wins / generation_loses / ambiguous / "
        "NOT_RUN with reason)."
    )


def test_decision_log_valid_json() -> None:
    """Decision log must be valid JSON and a dict."""
    text = DECISION_LOG.read_text(encoding="utf-8")
    data = json.loads(text)
    assert isinstance(data, dict), "decision log must be a JSON object"


def test_outcome_present_and_valid() -> None:
    """outcome field must exist and be one of the four legal values."""
    data = json.loads(DECISION_LOG.read_text(encoding="utf-8"))
    assert "outcome" in data, "missing 'outcome' field in decision log"
    assert data["outcome"] in VALID_OUTCOMES, (
        f"outcome {data['outcome']!r} is not one of {sorted(VALID_OUTCOMES)}"
    )


def test_not_run_has_non_empty_reason() -> None:
    """NOT_RUN outcome requires a non-empty 'reason' field."""
    data = json.loads(DECISION_LOG.read_text(encoding="utf-8"))
    if data.get("outcome") != "NOT_RUN":
        return
    assert "reason" in data, "NOT_RUN decision log requires a 'reason' field"
    assert isinstance(data["reason"], str) and data["reason"].strip(), (
        "'reason' must be a non-empty string"
    )


def test_ran_outcome_has_four_questions() -> None:
    """If the spike ran (outcome != NOT_RUN), all four evaluation questions must be answered."""
    data = json.loads(DECISION_LOG.read_text(encoding="utf-8"))
    if data.get("outcome") == "NOT_RUN":
        return
    required = [
        "silhouette_readable_at_40px",
        "identity_holds_across_frames",
        "beats_synthetic_at_game_scale",
        "failure_mode",
    ]
    assert "questions" in data, (
        "non-NOT_RUN outcome requires a 'questions' field with the four evaluation answers"
    )
    for q in required:
        assert q in data["questions"], (
            f"missing required question '{q}' in decision log 'questions' field"
        )
