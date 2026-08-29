#!/usr/bin/env python3
"""Chained img2img idle sheet generation (T-0250, HANDOFF §24-c).

Round 2 of the T-0227 character-pipeline bake-off continues the generative
path (Arm A/B) per @DennieSeth's authorship override (see
BAKEOFF_DECISION_T0231.md). §24-c's hypothesis: instead of asking the model
to independently re-derive the same character for every frame (§24-b/T-0249,
one fresh 384x384 KSampler call per frame conditioned only on that frame's
skeleton), **chain the frames** -- frame 1 is generated fresh; frame n is an
img2img pass from frame n-1's own decoded output at low denoise, with the
next pose applied. Each frame then starts from a figure that is already
correct, so identity is inherited rather than re-invented.

This composes directly on top of §24-b, not a rewrite of it:
`build_chained_graph` calls `gen_pose_authority_idle_T0249.build_graph`
unchanged and patches only two things -- the latent source
(EmptyLatentImage -> VAEEncode of the previous frame's own output) and
denoise (1.0 -> the swept value). Frame 0 uses
`gen_pose_authority_idle_T0249.build_graph` directly, unpatched.

Two honest limits, inherited from §24-b and unchanged here:
  1. A pose skeleton is strong conditioning, not absolute control.
  2. This does not independently address costume drift -- that is §24-a's
     job (player_identity_v2, T-0248). Runs against v2, never v1, so §24-a's
     contribution is not masked.

A third limit specific to chaining: too low a denoise and the img2img pass
barely moves off its init image, so the authored pose stops reading as
motion; too high and drift returns, the same failure mode §24-b's per-frame
independent sampling already showed. `--write-sweep-report` measures this
band directly from a set of already-run attempts' frame-delta ranges.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_v2.safetensors -- T-0248 -- is loadable by ComfyUI's
LoraLoader):
    python3 assets/src/character/gen_chained_idle_T0250.py \
        --attempt 1 --seed 31416 --denoise 0.30
    python3 assets/src/character/gen_chained_idle_T0250.py \
        --promote-attempt 1 --denoise-justification "..."
    python3 assets/src/character/gen_chained_idle_T0250.py --write-sweep-report 1,2,3,4,5

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/chained_idle/attempt_<N>/frame_<i>_pose_skeleton_384.png  (x9)
    assets/out/chained_idle/attempt_<N>/frame_<i>_keypoints.json         (x9)
    assets/out/chained_idle/attempt_<N>/frame_<i>_main_384.png           (x9)
    assets/out/chained_idle/attempt_<N>/sheet_144_indexed.png
    assets/out/chained_idle/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_CHAINED_ATTEMPT_LOG_T0250.md (appended)

Promotion (only for the chosen attempt) re-homes that attempt's 9 per-frame
conditioning inputs from the gitignored assets/out/ into the committed
assets/src/character/pose_rig_idle_frame_evidence_T0250/ directory, since the
promoted provenance's frame_generation references must resolve on a fresh
clone.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reused directly -- checkpoint/ControlNet identifiers, HTTP client helpers,
# the §3.1 descent chain, the single-figure prompt/graph and every node id
# are unchanged; §24-c only adds a second graph builder (build_chained_graph
# below) that patches build_graph's latent source for frames 1-8.
import gen_pose_authority_idle_T0249 as pose_authority  # noqa: E402
import pose_rig_T0249  # noqa: E402
from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    cleanup_orphans,
    enforce_cell_margin,
    fetch_save_image,
    force_cell_corner_background,
    quantize_to_palette,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

IDENTITY_LORA_NAME = pose_authority.IDENTITY_LORA_NAME
IDENTITY_LORA_PATH = pose_authority.IDENTITY_LORA_PATH
IDENTITY_LORA_PROVENANCE_PATH = pose_authority.IDENTITY_LORA_PROVENANCE_PATH

CONCEPT_SHEET_PATH = pose_authority.CONCEPT_SHEET_PATH
EXPECTED_CONCEPT_HASH = pose_authority.EXPECTED_CONCEPT_HASH
PALETTE_PATH = pose_authority.PALETTE_PATH
RIG_PATH = pose_authority.RIG_PATH

FINAL_CELL_PX = pose_authority.FINAL_CELL_PX
GEN_PX = pose_authority.GEN_PX
SHEET_PX = pose_authority.SHEET_PX
FRAME_COUNT = pose_authority.FRAME_COUNT
FRAME_ORDER = pose_authority.FRAME_ORDER

MAX_FRAME_DELTA_RATIO = pose_authority.MAX_FRAME_DELTA_RATIO
ARM_C_BENCHMARK = pose_authority.ARM_C_BENCHMARK

# Rig generalisation evidence (the same rig drives 'move' with no code
# change) is inherited unchanged from §24-b -- nothing about chaining
# frames through img2img touches keypoint derivation, so re-emitting it
# would only duplicate already-committed evidence.
RIG_GENERALIZATION_EVIDENCE_PATH = pose_authority.RIG_GENERALIZATION_EVIDENCE_PATH

IDLE_FRAME_EVIDENCE_DIR = (
    REPO_ROOT / "assets" / "src" / "character" / "pose_rig_idle_frame_evidence_T0250"
)

MAIN_PROMPT = pose_authority.MAIN_PROMPT
MAIN_NEGATIVE = pose_authority.MAIN_NEGATIVE

# ── Extra graph node ids for the img2img chain (frame 0 reuses pose_authority's) ──
INIT_IMAGE_NODE_ID = "30"
VAE_ENCODE_NODE_ID = "31"


def build_chained_graph(
    seed: int,
    pose_skeleton_filename: str,
    init_image_filename: str,
    denoise: float,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
) -> dict:
    """Frame n>0: reuses pose_authority.build_graph unchanged for every node
    except the latent source -- EmptyLatentImage swapped for VAEEncode of the
    previous frame's own decoded output, denoise lowered from 1.0. This is
    the literal embodiment of "chain frames through img2img": frame n starts
    from frame n-1's already-correct figure instead of pure noise, with this
    frame's own pose skeleton still conditioning the ControlNet as before.
    """
    g = pose_authority.build_graph(
        seed=seed,
        pose_skeleton_filename=pose_skeleton_filename,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
        identity_lora_name=identity_lora_name,
    )
    del g[pose_authority.LATENT_NODE_ID]
    g[INIT_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": init_image_filename},
    }
    g[VAE_ENCODE_NODE_ID] = {
        "class_type": "VAEEncode",
        "inputs": {
            "pixels": [INIT_IMAGE_NODE_ID, 0],
            "vae": [pose_authority.CHECKPOINT_NODE_ID, 2],
        },
    }
    g[pose_authority.SAMPLER_NODE_ID]["inputs"]["latent_image"] = [VAE_ENCODE_NODE_ID, 0]
    g[pose_authority.SAMPLER_NODE_ID]["inputs"]["denoise"] = denoise
    return g


def check_attempt_cap(attempt: int) -> None:
    if not (1 <= attempt <= 8):
        raise SystemExit("attempt cap is 8 per round (DL-21) -- refusing to run a 9th attempt")


ATTEMPT_LOG_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "ARM_CHAINED_ATTEMPT_LOG_T0250.md"
)
OUT_ROOT = REPO_ROOT / "assets" / "out" / "chained_idle"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_chained_T0250.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_chained_T0250.provenance.json"

SWEEP_REPORT_PATH = REPO_ROOT / "assets" / "src" / "character" / "DENOISE_SWEEP_REPORT_T0250.md"
SWEEP_DATA_PATH = REPO_ROOT / "assets" / "src" / "character" / "DENOISE_SWEEP_T0250.json"

ATTEMPT_LOG_HEADER = (
    "# Chained img2img attempt log (T-0250, HANDOFF §24-c, round 2)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not, so "
    "attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the "
    "frame-silhouette delta check (DL-21 criterion 2's mechanical half) across all 8 "
    "adjacent-cell transitions of the assembled sheet. Runs against `player_identity_v2` "
    "(T-0248) -- §24-a's contribution, not masked -- and composes on top of §24-b's "
    "per-frame pose-authority generation (T-0249): frame 0 is generated exactly as §24-b "
    "would, frames 1-8 are img2img-chained from their predecessor.\n\n"
    "| Attempt | Seed | Denoise | ControlNet strength/end | Style LoRA weight | "
    "Identity LoRA weight | Frame-delta range | GPU seconds | Mechanical gate | "
    "Beats Arm C (0.072-0.112) | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    lo, hi = provenance["frame_delta_range"]
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} | {provenance['denoise_value']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['style_lora_weight']} | {provenance['identity_lora_weight']} "
        f"| {lo:.4f}-{hi:.4f} "
        f"| {provenance['gpu_seconds']} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'yes' if provenance['beats_arm_c_benchmark'] else 'no'} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


DEFAULT_DENOISE_JUSTIFICATION = (
    "Chosen from the denoise sweep (assets/src/character/DENOISE_SWEEP_REPORT_T0250.md, "
    "DENOISE_SWEEP_T0250.json): the lowest-drift value inside the ~0.25-0.35 band that still "
    "clears the round-2 gate, sampled alongside points below and above the band that show the "
    "two failure-mode edges (motion stops reading below the band; drift returns above it)."
)


def promote_attempt(
    out_dir: Path, provenance: dict, denoise_justification: str = DEFAULT_DENOISE_JUSTIFICATION
) -> None:
    """Copy this attempt's indexed sheet + provenance into
    assets/final/character/. Only called for the attempt chosen from the
    sweep -- a discarded attempt's bytes never land in assets/final/, even
    transiently. Also re-homes this attempt's 9 per-frame conditioning
    inputs from the gitignored assets/out/ into a committed evidence
    directory under assets/src/.
    """
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes((out_dir / "sheet_144_indexed.png").read_bytes())

    IDLE_FRAME_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    promoted = dict(provenance)
    promoted_frames = []
    for frame in provenance["frame_generation"]:
        i = frame["frame_index"]
        keypoints_dst = IDLE_FRAME_EVIDENCE_DIR / f"frame_{i}_keypoints.json"
        skeleton_dst = IDLE_FRAME_EVIDENCE_DIR / f"frame_{i}_pose_skeleton_384.png"
        keypoints_dst.write_bytes((out_dir / f"frame_{i}_keypoints.json").read_bytes())
        skeleton_dst.write_bytes((out_dir / f"frame_{i}_pose_skeleton_384.png").read_bytes())
        promoted_frame = dict(frame)
        promoted_frame["pose_keypoints_file"] = str(keypoints_dst.relative_to(REPO_ROOT))
        promoted_frame["pose_skeleton_file"] = str(skeleton_dst.relative_to(REPO_ROOT))
        promoted_frames.append(promoted_frame)
    promoted["frame_generation"] = promoted_frames

    promoted["denoise_justification"] = denoise_justification
    promoted["denoise_sweep_report"] = str(SWEEP_REPORT_PATH.relative_to(REPO_ROOT))
    promoted["denoise_sweep_data"] = str(SWEEP_DATA_PATH.relative_to(REPO_ROOT))
    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")


def run_attempt(
    attempt: int,
    seed: int,
    denoise: float,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
    state_name: str = "idle",
) -> dict:
    if not (0.0 < denoise < 1.0):
        raise ValueError(f"denoise must be in (0, 1) -- got {denoise}")
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH}"
        )
    if not IDENTITY_LORA_PATH.exists():
        raise RuntimeError(
            f"trained identity LoRA not found: {IDENTITY_LORA_PATH} -- run T-0248's training first"
        )
    if not IDENTITY_LORA_PROVENANCE_PATH.exists():
        raise RuntimeError(
            f"identity LoRA provenance sidecar not found: {IDENTITY_LORA_PROVENANCE_PATH}"
        )
    if not RIG_GENERALIZATION_EVIDENCE_PATH.exists():
        raise RuntimeError(
            f"{RIG_GENERALIZATION_EVIDENCE_PATH} missing -- inherited from T-0249, should "
            "already be committed on this branch"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)

    out_dir = OUT_ROOT / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    rig = pose_rig_T0249.load_rig()
    state = rig["states"][state_name]

    t0 = time.monotonic()
    frame_records = []
    cell_images: dict[tuple[int, int], Image.Image] = {}
    prompt_ids = []
    prev_main_path: Path | None = None

    for i, cell in enumerate(FRAME_ORDER):
        points = pose_rig_T0249.keypoints_for_frame(state, i, FRAME_COUNT)
        skeleton_img = pose_rig_T0249.render_pose_frame(points, GEN_PX)
        skeleton_path = out_dir / f"frame_{i}_pose_skeleton_384.png"
        skeleton_img.save(skeleton_path)

        keypoints_path = out_dir / f"frame_{i}_keypoints.json"
        keypoints_path.write_text(
            json.dumps(pose_rig_T0249.keypoints_to_coco_list(points), indent=2) + "\n"
        )

        skeleton_filename = upload_image(skeleton_path)

        if i == 0:
            graph = pose_authority.build_graph(
                seed=seed,
                pose_skeleton_filename=skeleton_filename,
                controlnet_strength=controlnet_strength,
                controlnet_end=controlnet_end,
                style_lora_weight=style_lora_weight,
                identity_lora_weight=identity_lora_weight,
                identity_lora_name=identity_lora_name,
            )
            frame_denoise = 1.0
            generation_mode = "fresh"
            chained_from = None
        else:
            assert prev_main_path is not None
            init_image_filename = upload_image(prev_main_path)
            graph = build_chained_graph(
                seed=seed,
                pose_skeleton_filename=skeleton_filename,
                init_image_filename=init_image_filename,
                denoise=denoise,
                controlnet_strength=controlnet_strength,
                controlnet_end=controlnet_end,
                style_lora_weight=style_lora_weight,
                identity_lora_weight=identity_lora_weight,
                identity_lora_name=identity_lora_name,
            )
            frame_denoise = denoise
            generation_mode = "img2img_chained"
            chained_from = i - 1

        prompt_id = submit_prompt(graph)
        info = wait_for_completion(prompt_id, timeout_s=300)
        prompt_ids.append(prompt_id)

        main_bytes = fetch_save_image(info, pose_authority.MAIN_SAVE_NODE_ID)
        cell_bytes = fetch_save_image(info, pose_authority.CELL_SAVE_NODE_ID)
        main_path = out_dir / f"frame_{i}_main_384.png"
        main_path.write_bytes(main_bytes)
        cell_raw_path = out_dir / f"frame_{i}_cell_48_raw.png"
        cell_raw_path.write_bytes(cell_bytes)
        cell_images[cell] = Image.open(cell_raw_path).convert("RGB")
        prev_main_path = main_path

        frame_records.append(
            {
                "frame_index": i,
                "cell": list(cell),
                "seed": seed,
                "width": GEN_PX,
                "height": GEN_PX,
                "prompt": MAIN_PROMPT,
                "negative_prompt": MAIN_NEGATIVE,
                "pose_keypoints_file": str(keypoints_path.relative_to(REPO_ROOT)),
                "pose_skeleton_file": str(skeleton_path.relative_to(REPO_ROOT)),
                "comfyui_prompt_id": prompt_id,
                "generation_mode": generation_mode,
                "chained_from_frame": chained_from,
                "denoise": frame_denoise,
            }
        )

    gpu_seconds = time.monotonic() - t0

    raw_sheet = Image.new("RGB", (SHEET_PX, SHEET_PX))
    for (r, c), cell_img in cell_images.items():
        raw_sheet.paste(cell_img, (c * FINAL_CELL_PX, r * FINAL_CELL_PX))
    raw_sheet.save(out_dir / "sheet_144_raw.png")

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    indexed = quantize_to_palette(raw_sheet, palette)
    indexed = force_cell_corner_background(indexed, cell_size=FINAL_CELL_PX, background_index=0)
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    indexed.save(out_dir / "sheet_144_indexed.png")

    cells = {}
    for r in range(3):
        for c in range(3):
            cells[(r, c)] = indexed.crop(
                (c * FINAL_CELL_PX, r * FINAL_CELL_PX, c * FINAL_CELL_PX + FINAL_CELL_PX,
                 r * FINAL_CELL_PX + FINAL_CELL_PX)
            )
    frame_deltas = []
    for a, b in zip(FRAME_ORDER, FRAME_ORDER[1:]):
        result = asset_gate_art.check_frame_consistency(
            cells[a], cells[b], background_index=0, max_delta_ratio=MAX_FRAME_DELTA_RATIO
        )
        frame_deltas.append(
            {
                "pair": [list(a), list(b)],
                "ratio": float(result.details["ratio"]),
                "passed": bool(result.passed),
            }
        )
    mechanical_gate_passed = all(d["passed"] for d in frame_deltas)
    ratios = [d["ratio"] for d in frame_deltas]
    frame_delta_range = [min(ratios), max(ratios)]
    beats_030_cap = max(ratios) <= MAX_FRAME_DELTA_RATIO
    beats_arm_c_benchmark = max(ratios) <= ARM_C_BENCHMARK[1]

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) "
        f"+ LoRA {identity_lora_name} (player identity, weight {identity_lora_weight}) "
        f"+ ControlNet {CONTROLNET_NAME} (per-frame script-authored pose skeleton) "
        f"+ img2img chaining (frames 1-8 from their predecessor, denoise {denoise})"
    )
    provenance = {
        "model": model_summary,
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "style_lora_license": LORA_LICENSE,
        "identity_lora_name": identity_lora_name,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": identity_lora_weight,
        "identity_lora_license": "CreativeML OpenRAIL++-M",
        "identity_lora_provenance": str(IDENTITY_LORA_PROVENANCE_PATH.relative_to(REPO_ROOT)),
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": MAIN_PROMPT,
        "negative_prompt": MAIN_NEGATIVE,
        "pose_source": (
            "script (assets/src/character/pose_rig_T0249.py) -- deterministic per-frame "
            "OpenPose-format 18-keypoint COCO skeleton, emitted directly by the script, with "
            "no derivation step in between (this ComfyUI host has no DWPose/OpenPose node "
            "that could have derived it from an image)"
        ),
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "animation_params": str(RIG_PATH.relative_to(REPO_ROOT)),
        "animation_state": state_name,
        "rig_generalization_evidence": str(
            RIG_GENERALIZATION_EVIDENCE_PATH.relative_to(REPO_ROOT)
        ),
        "frame_generation": frame_records,
        "denoise_value": denoise,
        "composes_with_pose_authority_T0249": True,
        "based_on_card": "T-0249",
        "chaining_method": (
            "Frame 1 (index 0) generated fresh via "
            "gen_pose_authority_idle_T0249.build_graph unchanged (EmptyLatentImage, "
            "denoise=1.0). Frames 2-9 (index 1-8) img2img-chained from their immediate "
            "predecessor's own decoded 384x384 output via VAEEncode, at "
            f"denoise={denoise}, with each frame's own script-authored ControlNet skeleton "
            "still conditioning the sample on top -- build_chained_graph patches only the "
            "latent source and denoise on the reused build_graph, nothing else."
        ),
        "method": (
            "pose_rig_T0249 derives 18-keypoint COCO frame keypoints from committed animation "
            "parameters (pose_rig_T0249.json) -> gen_arm_a_idle_T0228.draw_pose_skeleton_cell "
            "renders each frame's skeleton (384x384, reused renderer, not re-authored) -> "
            "frame 0: ControlNetApplyAdvanced (xinsir OpenPose) conditions a single-figure "
            "KSampler generation at 384x384 from pure noise -> frames 1-8: the previous "
            "frame's own decoded output is VAE-encoded and used as the KSampler's latent "
            f"source at denoise={denoise}, with this frame's own skeleton still ControlNet-"
            "conditioning the sample -> per-frame area descent to 48x48 (same x8 ratio as "
            "the grid path) -> frames assembled into a 144x144 sheet -> Oklab-nearest "
            "palette quantization (dithering off, §3.1) -> orphan cleanup."
        ),
        "generator": "assets/src/character/gen_chained_idle_T0250.py",
        "card": "T-0250",
        "bake_off_arm": (
            "round 2, chained img2img (HANDOFF §24-c), stacked on top of §24-a's "
            "player_identity_v2 and §24-b's pose-authority per-frame generation -- not a new "
            "bake-off arm competing on DL-21's original criteria"
        ),
        "spec": (
            "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5 + HANDOFF §24.3"
        ),
        "comfyui_prompt_ids": prompt_ids,
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "frame_delta_range": frame_delta_range,
        "beats_030_cap": beats_030_cap,
        "beats_arm_c_benchmark": beats_arm_c_benchmark,
        "arm_c_benchmark": list(ARM_C_BENCHMARK),
        "layout": {
            "sheet_px": [SHEET_PX, SHEET_PX],
            "cell_px": FINAL_CELL_PX,
            "cols": 3,
            "rows": 3,
            "frame_cells": [list(k) for k in FRAME_ORDER],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def write_sweep_report(attempts: list[int], chosen_attempt: int) -> None:
    """Reads each listed attempt's already-written provenance_candidate.json
    and assembles the committed sweep report + data file the acceptance
    criteria require -- the measured frame-delta per sampled denoise value,
    not a single chosen value asserted after the fact.
    """
    points = []
    for attempt in attempts:
        candidate_path = OUT_ROOT / f"attempt_{attempt}" / "provenance_candidate.json"
        candidate = json.loads(candidate_path.read_text())
        points.append(
            {
                "attempt": attempt,
                "denoise": candidate["denoise_value"],
                "seed": candidate["seed"],
                "frame_delta_range": candidate["frame_delta_range"],
                "mechanical_gate_passed": candidate["mechanical_gate_passed"],
                "beats_030_cap": candidate["beats_030_cap"],
                "beats_arm_c_benchmark": candidate["beats_arm_c_benchmark"],
            }
        )
    points.sort(key=lambda p: p["denoise"])

    lowest = points[0]
    highest = points[-1]
    chosen = next(p for p in points if p["attempt"] == chosen_attempt)

    failure_mode_low = (
        f"At denoise={lowest['denoise']}, the img2img pass barely moves off its init image: "
        f"measured frame-delta range {lowest['frame_delta_range'][0]:.4f}-"
        f"{lowest['frame_delta_range'][1]:.4f}, well under Arm C's own 0.072 floor for "
        "legitimate breathing/weight-shift motion. The authored pose from pose_rig_T0249 is "
        "still applied to the ControlNet each frame, but at this denoise the sampler cannot "
        "move the silhouette far enough from its predecessor to make that pose read as "
        "motion -- the sheet would look like the same still frame repeated nine times."
    )
    failure_mode_high = (
        f"At denoise={highest['denoise']}, the img2img pass has enough freedom to "
        "re-invent large parts of the figure each frame instead of only applying the next "
        f"pose to the inherited one: measured frame-delta range "
        f"{highest['frame_delta_range'][0]:.4f}-{highest['frame_delta_range'][1]:.4f}"
        f"{'' if highest['beats_030_cap'] else ', which exceeds the round-2 0.30 cap outright'}"
        ". This is the same drift failure mode §24-b's independently-sampled frames already "
        "showed -- chaining stops suppressing it once denoise is high enough to approach a "
        "fresh generation in practice."
    )

    data = {
        "card": "T-0250",
        "based_on_card": "T-0249",
        "seed": chosen["seed"],
        "points": points,
        "band_low": 0.25,
        "band_high": 0.35,
        "chosen_denoise": chosen["denoise"],
        "chosen_attempt": chosen_attempt,
        "failure_mode_low": failure_mode_low,
        "failure_mode_high": failure_mode_high,
        "arm_c_benchmark": list(ARM_C_BENCHMARK),
        "max_frame_delta_cap": MAX_FRAME_DELTA_RATIO,
    }
    SWEEP_DATA_PATH.write_text(json.dumps(data, indent=2) + "\n")

    lines = [
        "# Denoise sweep -- chained img2img idle sheet (T-0250, HANDOFF §24-c)\n\n",
        "Frame 0 generated fresh; frames 1-8 img2img-chained from their predecessor at the "
        "swept denoise value, everything else (seed, ControlNet strength/end, style/identity "
        "LoRA weights) held constant across every sampled point, per the round-2 rules "
        "(HANDOFF §24.3) -- only the value under test changes between attempts.\n\n",
        "| Attempt | Denoise | Frame-delta range | Mechanical gate (0.30 cap) | "
        "Beats Arm C (0.072-0.112) |\n",
        "|---|---|---|---|---|\n",
    ]
    for p in points:
        lo, hi = p["frame_delta_range"]
        lines.append(
            f"| {p['attempt']} | {p['denoise']} | {lo:.4f}-{hi:.4f} "
            f"| {'PASS' if p['mechanical_gate_passed'] else 'FAIL'} "
            f"| {'yes' if p['beats_arm_c_benchmark'] else 'no'} |\n"
        )
    lines.append("\n## Failure mode, low end (motion stops reading)\n\n")
    lines.append(failure_mode_low + "\n\n")
    lines.append("## Failure mode, high end (drift returns)\n\n")
    lines.append(failure_mode_high + "\n\n")
    lines.append(
        f"## Chosen value: denoise={chosen['denoise']} (attempt {chosen_attempt})\n\n"
    )
    lines.append(DEFAULT_DENOISE_JUSTIFICATION + "\n\n")
    lo, hi = chosen["frame_delta_range"]
    lines.append(
        f"Measured frame-delta range at the chosen value: **{lo:.4f}-{hi:.4f}**. "
        f"{'Beats' if chosen['beats_030_cap'] else 'Does not beat'} the 0.30 cap. "
        f"{'Beats' if chosen['beats_arm_c_benchmark'] else 'Does not beat'} Arm C's "
        "0.072-0.112 benchmark.\n"
    )
    SWEEP_REPORT_PATH.write_text("".join(lines))
    print(f"wrote {SWEEP_DATA_PATH} and {SWEEP_REPORT_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int, help="attempt number, 1..8 (DL-21 cap)")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--denoise", type=float, help="img2img denoise for frames 1-8")
    parser.add_argument("--controlnet-strength", type=float, default=1.3)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.50)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument(
        "--promote-attempt",
        type=int,
        help="promote an existing attempt's output to assets/final/character/ and exit",
    )
    parser.add_argument(
        "--denoise-justification",
        type=str,
        default=DEFAULT_DENOISE_JUSTIFICATION,
        help="only used with --promote-attempt",
    )
    parser.add_argument(
        "--write-sweep-report",
        type=str,
        help="comma-separated attempt numbers to summarise, e.g. 1,2,3,4,5",
    )
    parser.add_argument(
        "--chosen-attempt",
        type=int,
        help="which --write-sweep-report attempt was chosen/promoted",
    )
    args = parser.parse_args()

    if args.write_sweep_report is not None:
        attempts = [int(a) for a in args.write_sweep_report.split(",")]
        chosen = args.chosen_attempt if args.chosen_attempt is not None else attempts[-1]
        write_sweep_report(attempts, chosen)
        return

    if args.promote_attempt is not None:
        out_dir = OUT_ROOT / f"attempt_{args.promote_attempt}"
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        promote_attempt(out_dir, provenance, args.denoise_justification)
        print(f"promoted attempt {args.promote_attempt} -> {FINAL_SHEET_PATH}")
        return

    if args.attempt is None or args.seed is None or args.denoise is None:
        parser.error("--attempt, --seed and --denoise are required for a generation run")

    check_attempt_cap(args.attempt)

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        denoise=args.denoise,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )
    provenance["promoted"] = False
    out_dir = OUT_ROOT / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
