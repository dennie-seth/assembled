"""T-0255 (HANDOFF §24, handle §24-f) — round-2 comparison: side-by-side
artefact against Arm C as benchmark, frame-silhouette delta gate re-run, and
the skipped-arm record for the round-2 card set DL-23 raised
(docs/decision-log.md).

Every arm below composes on top of §24-a's `player_identity_v2` LoRA
(T-0248) — the shared base, not a variable; each round-2 card's own report
already pins this in its own gate suite (e.g. `test_identity_lora_is_v2`).
This module only re-verifies and assembles outputs the round-2 cards already
produced: it generates no new character pixels and invents no criterion-1
verdict. See `assets/src/character/ROUND2_DECISION_T0255.md` for how the
human read is recorded and parked -- for the round-2 arms and, since none of
them beats Arm C's benchmark, for Arm C's own still-outstanding criterion-1
sign-off too.
"""

from __future__ import annotations

from pathlib import Path
from typing import NamedTuple

from char_gen import bakeoff_compare as round1

CHAR_DIR = round1.CHAR_DIR
REPO_ROOT = round1.REPO_ROOT
FINAL_DIR = round1.FINAL_DIR

CELL_SIZE = round1.CELL_SIZE
# DL-21 criterion 2's 0.30 cap; unchanged for round 2 per DL-23.
MAX_FRAME_DELTA_RATIO = round1.MAX_FRAME_DELTA_RATIO
FRAME_CELLS = round1.FRAME_CELLS
ADJACENT_PAIRS = round1.ADJACENT_PAIRS
compute_frame_deltas = round1.compute_frame_deltas

# §24.3: "Arm C's 0.072-0.112 is the bar to BEAT, not the gate to clear."
ARM_C_BENCHMARK_MIN = 0.072
ARM_C_BENCHMARK_MAX = 0.112


class Round2Arm(NamedTuple):
    key: str
    label: str
    card: str
    handle: str
    sheet: Path
    provenance: Path
    preview_gif: Path


ARMS: list[Round2Arm] = [
    Round2Arm(
        key="arm_c_benchmark",
        label="Arm C (benchmark, round 1)",
        card="T-0230",
        handle="§23-f",
        sheet=FINAL_DIR / "player_idle_sheet_arm_c_T0230.png",
        provenance=FINAL_DIR / "player_idle_sheet_arm_c_T0230.provenance.json",
        preview_gif=FINAL_DIR / "arm_c_judging_preview_T0230.gif",
    ),
    Round2Arm(
        key="pose_authority",
        label="Pose authority",
        card="T-0249",
        handle="§24-b",
        sheet=FINAL_DIR / "player_idle_sheet_pose_authority_T0249.png",
        provenance=FINAL_DIR / "player_idle_sheet_pose_authority_T0249.provenance.json",
        preview_gif=FINAL_DIR / "pose_authority_judging_preview_T0249.gif",
    ),
    Round2Arm(
        key="chained",
        label="Chained img2img",
        card="T-0250",
        handle="§24-c",
        sheet=FINAL_DIR / "player_idle_sheet_chained_T0250.png",
        provenance=FINAL_DIR / "player_idle_sheet_chained_T0250.provenance.json",
        preview_gif=FINAL_DIR / "chained_judging_preview_T0250.gif",
    ),
    Round2Arm(
        key="hybrid",
        label="Hybrid (SDXL look + scripted motion)",
        card="T-0252",
        handle="§24-e",
        sheet=FINAL_DIR / "player_idle_sheet_hybrid_T0252.png",
        provenance=FINAL_DIR / "player_idle_sheet_hybrid_T0252.provenance.json",
        preview_gif=FINAL_DIR / "hybrid_judging_preview_T0252.gif",
    ),
]


class SkippedArm(NamedTuple):
    key: str
    label: str
    card: str
    handle: str
    reason: str
    evidence: Path


SKIPPED_ARMS: list[SkippedArm] = [
    SkippedArm(
        key="animatediff",
        label="AnimateDiff (temporal-consistency motion module)",
        card="T-0251",
        handle="§24-d",
        reason=(
            "No usable SDXL motion module on the installed ComfyUI host: zero "
            "AnimateDiff/AnimateDiff-Evolved node types under any of four search "
            "patterns, no animatediff_models/motion_module folder type registered, "
            "both motion-module model routes 404. Confirmed by 5 read-only HTTP "
            "queries against the host -- no checkpoint load, no sampling. Installing "
            "a new custom node pack on the shared host is a standing environment "
            "change outside an implementer agent's remit, not something this card "
            "does unattended to manufacture a pass. A complete, evidence-backed stop "
            "per the card's own instructions, not a missing input."
        ),
        evidence=CHAR_DIR / "ROUND2_ANIMATEDIFF_CAPABILITY_REPORT_T0251.md",
    ),
]


def beats_benchmark(deltas: list[dict]) -> bool:
    """True only if every adjacent-cell ratio is within Arm C's own worst
    transition (0.112) -- clearing the 0.30 cap alone is not enough."""
    return bool(max(d["ratio"] for d in deltas) <= ARM_C_BENCHMARK_MAX)


def clears_030_cap(deltas: list[dict]) -> bool:
    return bool(all(d["passed"] for d in deltas))


def _json_safe_deltas(deltas: list[dict]) -> list[dict]:
    """`round1.compute_frame_deltas` returns `passed` as `numpy.bool_`
    (from `asset_gate.art.check_frame_consistency`'s own `CheckResult`),
    which `json.dumps` cannot serialize -- normalize to native `bool` for
    this module's own report output without touching round1's file."""
    return [{**d, "passed": bool(d["passed"])} for d in deltas]


def build_frame_delta_report() -> dict:
    report: dict = {
        "card": "T-0255",
        "handle": "HANDOFF §24-f",
        "spec": (
            "docs/decision-log.md DL-21 criterion 2 (mechanical half), unchanged "
            "for round 2 per DL-23"
        ),
        "max_delta_ratio_030_cap": MAX_FRAME_DELTA_RATIO,
        "arm_c_benchmark_min": ARM_C_BENCHMARK_MIN,
        "arm_c_benchmark_max": ARM_C_BENCHMARK_MAX,
        "arms": {},
        "skipped": {
            s.key: {
                "label": s.label,
                "card": s.card,
                "handle": s.handle,
                "reason": s.reason,
                "evidence": str(s.evidence.relative_to(REPO_ROOT)),
            }
            for s in SKIPPED_ARMS
        },
    }
    for arm in ARMS:
        deltas = compute_frame_deltas(arm.sheet)
        failed = [d for d in deltas if not d["passed"]]
        report["arms"][arm.key] = {
            "label": arm.label,
            "card": arm.card,
            "handle": arm.handle,
            "sheet": str(arm.sheet.relative_to(REPO_ROOT)),
            "deltas": _json_safe_deltas(deltas),
            "num_failed": len(failed),
            "clears_030_cap": clears_030_cap(deltas),
            "beats_arm_c_benchmark": beats_benchmark(deltas),
        }
    return report


COMPARISON_PANEL_W = round1.COMPARISON_PANEL_W
COMPARISON_PANEL_H = round1.COMPARISON_PANEL_H
COMPARISON_GAP = round1.COMPARISON_GAP
COMPARISON_LABEL_H = round1.COMPARISON_LABEL_H
COMPARISON_TITLE_H = round1.COMPARISON_TITLE_H
COMPARISON_MARGIN = round1.COMPARISON_MARGIN
COMPARISON_BG = round1.COMPARISON_BG
COMPARISON_FG = round1.COMPARISON_FG
COMPARISON_FRAME_MS = round1.COMPARISON_FRAME_MS


def comparison_title() -> str:
    return (
        "HANDOFF §24-f round-2 comparison -- DL-21/DL-23 judging conditions: "
        "40px, in motion, T-0192 blockout room (Arm C is the benchmark to beat)"
    )


def comparison_labels() -> list[str]:
    return [f"{arm.label} ({arm.handle}, {arm.card})" for arm in ARMS]


def comparison_layout() -> tuple[int, int, int]:
    """(width, height, y_panel) for the composite canvas."""
    n = len(ARMS)
    width = COMPARISON_MARGIN * 2 + n * COMPARISON_PANEL_W + (n - 1) * COMPARISON_GAP
    height = COMPARISON_MARGIN * 2 + COMPARISON_TITLE_H + COMPARISON_LABEL_H + COMPARISON_PANEL_H
    y_panel = COMPARISON_MARGIN + COMPARISON_TITLE_H + COMPARISON_LABEL_H
    return width, height, y_panel


def panel_x(index: int) -> int:
    return COMPARISON_MARGIN + index * (COMPARISON_PANEL_W + COMPARISON_GAP)


def build_comparison_frames() -> list:
    """Composite all four arms' already-rendered judging previews (each
    already 40px-scale, in motion, inside the T-0192 blockout-room mockup)
    into one side-by-side animated sequence, embedding each preview's real
    frame pixels directly (same technique as T-0231's
    `bakeoff_compare.build_comparison_frames`, generalised to this round's
    own arm set)."""
    from PIL import Image, ImageDraw

    per_arm_frames = [round1._load_preview_frames(arm.preview_gif) for arm in ARMS]
    frame_counts = {len(frames) for frames in per_arm_frames}
    if len(frame_counts) != 1:
        raise ValueError(f"arms have mismatched frame counts: {frame_counts}")
    n_frames = frame_counts.pop()

    width, height, y_panel = comparison_layout()
    title = comparison_title()
    labels = comparison_labels()

    composite_frames = []
    for frame_idx in range(n_frames):
        canvas = Image.new("RGB", (width, height), COMPARISON_BG)
        draw = ImageDraw.Draw(canvas)
        title_w = draw.textlength(title)
        draw.text((width / 2 - title_w / 2, COMPARISON_MARGIN), title, fill=COMPARISON_FG)
        y_label = COMPARISON_MARGIN + COMPARISON_TITLE_H
        for i in range(len(ARMS)):
            x = panel_x(i)
            label_w = draw.textlength(labels[i])
            draw.text(
                (x + COMPARISON_PANEL_W / 2 - label_w / 2, y_label), labels[i], fill=COMPARISON_FG
            )
            canvas.paste(per_arm_frames[i][frame_idx], (x, y_panel))
        composite_frames.append(canvas)
    return composite_frames


def main() -> None:
    import json

    delta_report = build_frame_delta_report()
    (FINAL_DIR / "round2_frame_delta_report_T0255.json").write_text(
        json.dumps(delta_report, indent=2) + "\n"
    )
    frames = build_comparison_frames()
    frames[0].save(
        FINAL_DIR / "round2_comparison_T0255.webp",
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=COMPARISON_FRAME_MS,
        loop=0,
        lossless=True,
        method=6,
    )
    print("wrote round2_frame_delta_report_T0255.json, round2_comparison_T0255.webp")


if __name__ == "__main__":
    main()
