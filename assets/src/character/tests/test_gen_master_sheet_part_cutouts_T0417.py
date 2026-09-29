"""Independent per-part SAM3 cutouts for the parts compositor (T-0417),
closing the gap the round-3 reviewer named exactly: T-0337's FIX ROUND 2
put valid hip/knee/ankle-derived points on the "legs" panel, but all six
positive points went into ONE `positive_coords` list through ONE
`SAM3_Detect` call -- "constraints on one segmentation, not six separately
identified part requests." These tests pin the structural fix: a bounded,
explicit set of SEPARATE part requests, each with its own single positive
point and its own negative points on every sibling part, each destined for
its own `SAM3_Detect` call -- and prove that structurally, offline, against
the workflow builder (no ComfyUI, no GPU).

RED state: `gen_master_sheet_part_cutouts_T0417` does not exist yet ->
ImportError.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_part_cutouts_T0417 as gen  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

from char_gen.cutout_sam3 import build_sam3_part_workflow  # noqa: E402

PANEL_SIZE = gen.PANEL_SIZE


class _StubComfyClient:
    """Minimal stand-in for `ComfyUIClient`'s `submit`/`wait_for_completion`/
    `fetch_output` surface -- enough for the production
    `_make_part_sam3_runner`'s own `_run()` closure to execute for real,
    offline, with no network. Records every submitted workflow so a test can
    assert on how many genuinely separate `SAM3_Detect` requests were made."""

    def __init__(self):
        self.submitted_workflows: list[dict] = []

    def submit(self, workflow: dict) -> str:
        self.submitted_workflows.append(workflow)
        return f"job-{len(self.submitted_workflows)}"

    def wait_for_completion(self, job_id: str, timeout: float = 60.0) -> dict:
        return {"job_id": job_id}

    def fetch_output(self, result: dict) -> bytes:
        arr = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=np.uint8)
        arr[0:4, 0:4] = 255
        buf = io.BytesIO()
        Image.fromarray(arr, mode="L").save(buf, format="PNG")
        return buf.getvalue()


class TestPartsByPanelIsExplicit:
    """"A panel that is not a parts panel (a whole-figure t-pose): it is not
    forced through part decomposition -- the set of parts per panel is
    explicit." Only "legs" -- the panel the round-3 review actually
    flagged -- has a part decomposition; every other panel's own set is
    empty, not derived, not guessed."""

    def test_legs_panel_has_six_bounded_parts(self):
        parts = gen.PARTS_BY_PANEL["legs"]
        assert len(parts) == 6
        assert len(set(parts)) == 6  # no duplicates
        for side in ("right", "left"):
            assert f"{side}_upper_leg" in parts
            assert f"{side}_lower_leg" in parts
            assert f"{side}_boot" in parts

    def test_whole_figure_panels_have_no_parts(self):
        whole_figure_keys = (
            "front_tpose",
            "back_tpose",
            "side_left_forward",
            "side_right_forward",
            "side_neutral",
        )
        for key in whole_figure_keys:
            assert gen.PARTS_BY_PANEL.get(key, ()) == ()

    def test_bounded_not_a_sweep_the_set_is_fixed_across_calls(self):
        first = gen.PARTS_BY_PANEL["legs"]
        second = gen.PARTS_BY_PANEL["legs"]
        assert first == second


class TestPartPromptPoints:
    """Each part gets exactly ONE positive point (its own anchor) and
    negative points on every sibling part's own anchor plus the panel's
    fixed corners/collapse point -- never the other parts' positive points
    folded into the same request."""

    def _points(self):
        return rig.keypoints_for("legs")

    def test_right_upper_leg_positive_is_the_hip_knee_midpoint(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_upper_leg", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 1
        hip_x, hip_y = points[8]  # _R_HIP
        knee_x, knee_y = points[9]  # _R_KNEE
        expected = (int((hip_x + knee_x) / 2 * PANEL_SIZE), int((hip_y + knee_y) / 2 * PANEL_SIZE))
        assert (positives[0]["x"], positives[0]["y"]) == expected

    def test_right_boot_positive_is_the_ankle_itself(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_boot", points, PANEL_SIZE)
        positives = [r for r in records if r["polarity"] == "positive"]
        assert len(positives) == 1
        ankle_x, ankle_y = points[10]  # _R_ANKLE
        assert (positives[0]["x"], positives[0]["y"]) == (
            int(ankle_x * PANEL_SIZE),
            int(ankle_y * PANEL_SIZE),
        )

    def test_negatives_include_every_sibling_part_anchor(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_upper_leg", points, PANEL_SIZE)
        negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
        siblings = (
            "right_lower_leg",
            "right_boot",
            "left_upper_leg",
            "left_lower_leg",
            "left_boot",
        )
        for sibling in siblings:
            sibling_records = gen.part_prompt_points("legs", sibling, points, PANEL_SIZE)
            sibling_anchor = next(
                (r["x"], r["y"]) for r in sibling_records if r["polarity"] == "positive"
            )
            assert sibling_anchor in negatives

    def test_negatives_include_four_corners_and_upper_body_collapse_point(self):
        points = self._points()
        records = gen.part_prompt_points("legs", "right_boot", points, PANEL_SIZE)
        negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
        assert (4, 4) in negatives
        assert (PANEL_SIZE - 4, 4) in negatives
        assert (4, PANEL_SIZE - 4) in negatives
        assert (PANEL_SIZE - 4, PANEL_SIZE - 4) in negatives
        neck_x, neck_y = points[1]
        assert (int(neck_x * PANEL_SIZE), int(neck_y * PANEL_SIZE)) in negatives

    def test_own_positive_point_never_appears_among_its_own_negatives(self):
        points = self._points()
        for part_key in gen.PARTS_BY_PANEL["legs"]:
            records = gen.part_prompt_points("legs", part_key, points, PANEL_SIZE)
            positive = next((r["x"], r["y"]) for r in records if r["polarity"] == "positive")
            negatives = {(r["x"], r["y"]) for r in records if r["polarity"] == "negative"}
            assert positive not in negatives

    def test_unknown_part_for_panel_raises(self):
        import pytest

        points = self._points()
        with pytest.raises(ValueError):
            gen.part_prompt_points("legs", "tail", points, PANEL_SIZE)

    def test_left_right_mirroring_uses_the_same_rule(self):
        # The rig's own left/right keypoints are exact horizontal mirrors of
        # each other (see pose_rig_master_sheet_T0351's LEGS_KEYPOINTS_NORM),
        # so a genuinely shared derivation rule must produce mirrored pixel
        # anchors too -- not independently hand-tuned per side.
        points = self._points()
        for right_key, left_key in (
            ("right_upper_leg", "left_upper_leg"),
            ("right_lower_leg", "left_lower_leg"),
            ("right_boot", "left_boot"),
        ):
            right_records = gen.part_prompt_points("legs", right_key, points, PANEL_SIZE)
            left_records = gen.part_prompt_points("legs", left_key, points, PANEL_SIZE)
            rx, ry = next((r["x"], r["y"]) for r in right_records if r["polarity"] == "positive")
            lx, ly = next((r["x"], r["y"]) for r in left_records if r["polarity"] == "positive")
            # Within 1px of an exact mirror -- int() truncation on the two
            # independently-averaged midpoints can round the pair to
            # PANEL_SIZE-1 rather than PANEL_SIZE (e.g. 358 + 665 = 1023),
            # which is a floating-point truncation artifact, not evidence
            # the two sides used a different rule.
            assert abs(lx - (PANEL_SIZE - rx)) <= 1
            assert ly == ry


class TestBuildSam3PartWorkflowIsCalledSeparatelyPerPart:
    """The structural assertion the round-2/round-3 shape would have
    caught: building the six parts' own workflows produces six DISTINCT
    graphs, each with exactly one positive coordinate (that part's own),
    never a single graph carrying all six parts' points together."""

    def test_each_part_builds_its_own_single_positive_coord_graph(self):
        points = rig.keypoints_for("legs")
        model_loader = {"class_type": "FakeSam3Loader", "inputs": {}}
        graphs = {}
        for part_key in gen.PARTS_BY_PANEL["legs"]:
            records = gen.part_prompt_points("legs", part_key, points, PANEL_SIZE)
            positive_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "positive"
            ]
            negative_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "negative"
            ]
            graphs[part_key] = build_sam3_part_workflow(
                "panel_legs.png",
                model_loader,
                positive_coords=positive_coords,
                negative_coords=negative_coords,
                filename_prefix=f"T0417_sam3_legs_{part_key}",
            )

        assert len(graphs) == 6
        import json

        positive_sets = set()
        for part_key, graph in graphs.items():
            coords = json.loads(graph["3"]["inputs"]["positive_coords"])
            assert len(coords) == 1  # exactly one positive point -- this part's own
            positive_sets.add((coords[0]["x"], coords[0]["y"]))
            negs = json.loads(graph["3"]["inputs"]["negative_coords"])
            assert len(negs) == 10  # 5 sibling anchors + 4 corners + collapse point

        # Six genuinely distinct segmentation requests, not six copies of one.
        assert len(positive_sets) == 6

    def test_runner_invocations_are_six_separate_calls_not_one_combined_call(self):
        """Drives the actual production `_make_part_sam3_runner` -- not a
        local stand-in -- once per part, against a stub `ComfyUIClient`
        that records every `submit()` call. This is what would have caught
        the withdrawn round-2 shape, which built exactly one combined
        runner for the whole panel: if `_make_part_sam3_runner` were ever
        called once per PANEL instead of once per PART, this test would see
        one submitted workflow carrying six positive coords, not six
        workflows each carrying one.

        (This replaces an earlier version of this test whose own docstring
        claimed to drive `_make_part_sam3_runner`, but which actually built
        a local `_fake_runner_factory` and looped over it itself -- proving
        only that its own loop ran six times, nothing about the production
        driver.)"""
        points = rig.keypoints_for("legs")
        client = _StubComfyClient()

        for part_key in gen.PARTS_BY_PANEL["legs"]:
            records = gen.part_prompt_points("legs", part_key, points, PANEL_SIZE)
            positive_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "positive"
            ]
            negative_coords = [
                {"x": r["x"], "y": r["y"]} for r in records if r["polarity"] == "negative"
            ]
            runner = gen._make_part_sam3_runner(
                client,
                "panel_legs.png",
                positive_coords,
                negative_coords,
                filename_prefix=f"T0417_sam3_legs_{part_key}",
            )
            mask = runner()
            assert mask.shape == (PANEL_SIZE, PANEL_SIZE)

        assert len(client.submitted_workflows) == 6
        positive_sets = set()
        for workflow in client.submitted_workflows:
            coords = json.loads(workflow["3"]["inputs"]["positive_coords"])
            assert len(coords) == 1  # never the six-point combined list the round-2 shape used
            positive_sets.add((coords[0]["x"], coords[0]["y"]))
        assert len(positive_sets) == 6  # six genuinely distinct requests, not six copies of one


class TestApplyOverlapRejection:
    """The half of "isolation judged on more than total area" that
    `_evaluate_overlaps` alone doesn't finish: a per-pair overlap verdict is
    useless to the parts compositor until it's folded back into each part's
    own `isolated` flag. Before this fix, `_evaluate_overlaps`'s
    `exceeds_tolerance` was written to `part_comparison.json` at panel level
    and consumed by nothing -- no part was ever rejected for overlapping a
    sibling, no matter how much it overlapped."""

    def _part(self, key, *, isolated=True, present=True):
        return {
            "panel": "legs",
            "part": key,
            "present": present,
            "isolated": isolated,
            "isolated_before_overlap": isolated,
            "overlap_exceeds_tolerance": False,
        }

    def test_no_pair_exceeds_tolerance_leaves_isolated_unchanged(self):
        parts = {
            "right_upper_leg": self._part("right_upper_leg"),
            "right_lower_leg": self._part("right_lower_leg"),
        }
        overlaps = [
            {
                "part_a": "right_upper_leg",
                "part_b": "right_lower_leg",
                "overlap_fraction": 0.09,
                "exceeds_tolerance": False,
                "tolerance": 0.25,
            }
        ]
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is True
        assert updated["right_lower_leg"]["isolated"] is True
        assert updated["right_upper_leg"]["overlap_exceeds_tolerance"] is False
        assert updated["right_lower_leg"]["overlap_exceeds_tolerance"] is False

    def test_an_exceeding_pair_rejects_BOTH_siblings_not_just_one(self):
        # mask_overlap_fraction can't say which side bled into the other, so
        # neither is treated as the innocent one -- this is the exact
        # round-3 failure mode (both legs' full masks reported as separate
        # parts, which would measure as near-total overlap).
        parts = {
            "right_upper_leg": self._part("right_upper_leg"),
            "right_lower_leg": self._part("right_lower_leg"),
            "right_boot": self._part("right_boot"),
        }
        overlaps = [
            {
                "part_a": "right_upper_leg",
                "part_b": "right_lower_leg",
                "overlap_fraction": 0.9,
                "exceeds_tolerance": True,
                "tolerance": 0.25,
            },
            {
                "part_a": "right_lower_leg",
                "part_b": "right_boot",
                "overlap_fraction": 0.0,
                "exceeds_tolerance": False,
                "tolerance": 0.25,
            },
        ]
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is False
        assert updated["right_lower_leg"]["isolated"] is False
        assert updated["right_upper_leg"]["overlap_exceeds_tolerance"] is True
        assert updated["right_lower_leg"]["overlap_exceeds_tolerance"] is True
        # The boot wasn't in the exceeding pair -- untouched.
        assert updated["right_boot"]["isolated"] is True
        assert updated["right_boot"]["overlap_exceeds_tolerance"] is False

    def test_a_part_already_rejected_on_stray_fraction_stays_rejected(self):
        # isolated_before_overlap carries the pre-overlap verdict forward --
        # overlap rejection can only ever turn isolated=True into False, it
        # can't paper over an existing area/stray-fragment rejection.
        parts = {
            "right_upper_leg": self._part("right_upper_leg", isolated=False),
            "right_lower_leg": self._part("right_lower_leg"),
        }
        overlaps = []
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is False
        assert updated["right_lower_leg"]["isolated"] is True

    def test_recomputing_from_a_stale_overlap_rejected_state_is_not_sticky(self):
        # A part previously rejected on overlap grounds (isolated already
        # False, overlap_exceeds_tolerance already True from a prior main()
        # pass) must be un-rejected if the CURRENT overlaps list no longer
        # flags it -- e.g. its sibling was re-run with `--part` and no
        # longer overlaps. isolated_before_overlap is what makes this safe:
        # it was never overwritten by the earlier overlap rejection.
        stale = self._part("right_upper_leg", isolated=True)
        stale["isolated"] = False
        stale["overlap_exceeds_tolerance"] = True
        parts = {"right_upper_leg": stale}
        updated = gen._apply_overlap_rejection(parts, overlaps=[])
        assert updated["right_upper_leg"]["isolated"] is True
        assert updated["right_upper_leg"]["overlap_exceeds_tolerance"] is False

    def test_a_part_absent_from_the_panel_is_never_checked(self):
        # left_upper_leg/left_lower_leg have no mask (present=False) so they
        # never appear in masks_by_part and never generate an overlap pair
        # -- _evaluate_overlaps already skips them; this just confirms
        # _apply_overlap_rejection doesn't require every PARTS_BY_PANEL key
        # to be present in the dict it's given.
        parts = {"left_boot": self._part("left_boot")}
        updated = gen._apply_overlap_rejection(parts, overlaps=[])
        assert updated["left_boot"]["isolated"] is True


class TestMainSam3UnavailableEdgeCase:
    """"SAM3 unavailable mid-run: the per-part pass reports the prerequisite
    and performs no comparison, exactly as T-0337's availability path
    already does; it never substitutes another model" (card's own
    edge-case wording). Runs fully offline: no ComfyUI, no GPU -- the
    availability probe is monkeypatched to report unavailable, before any
    SAM3_Detect call would be reachable, and `ComfyUIClient.submit` is
    monkeypatched to fail the test if part decomposition is attempted
    anyway."""

    def test_unavailable_prerequisite_skips_part_decomposition_entirely(
        self, tmp_path, monkeypatch
    ):
        evidence_dir = tmp_path / "evidence"
        monkeypatch.setattr(gen, "EVIDENCE_DIR", evidence_dir)
        monkeypatch.setattr(
            gen,
            "_probe_sam3_availability",
            lambda client: (
                {"available": False, "reason": "UNETLoader missing sam3 checkpoint"},
                None,
            ),
        )

        from comfy_client.comfyui_client import ComfyUIClient

        def _fail_if_submitted(self, workflow):
            raise AssertionError("submit() must never be called when SAM3 is unavailable")

        monkeypatch.setattr(ComfyUIClient, "submit", _fail_if_submitted)
        monkeypatch.setattr(sys, "argv", ["gen_master_sheet_part_cutouts_T0417.py"])

        gen.main()

        written = json.loads((evidence_dir / "part_comparison.json").read_text())
        assert written["sam3_availability"]["available"] is False
        assert written["panels"] == {}

    def test_unavailable_prerequisite_never_destroys_existing_evidence(self, tmp_path, monkeypatch):
        # The destructive shape this pins against: an earlier version of
        # main() unconditionally wrote `"panels": {}` on this short-circuit,
        # wiping out any part evidence a prior successful run had already
        # committed to part_comparison.json -- turning "SAM3 down this run"
        # into "SAM3 down this run AND we lost last run's results."
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir(parents=True)
        existing_panels = {
            "legs": {
                "parts": {"right_boot": {"present": True, "isolated": True}},
                "overlaps": [],
            }
        }
        (evidence_dir / "part_comparison.json").write_text(
            json.dumps({"panels": existing_panels, "run_id": "prior-run"}, indent=2) + "\n"
        )

        monkeypatch.setattr(gen, "EVIDENCE_DIR", evidence_dir)
        monkeypatch.setattr(
            gen,
            "_probe_sam3_availability",
            lambda client: ({"available": False, "reason": "host down"}, None),
        )

        from comfy_client.comfyui_client import ComfyUIClient

        def _fail_if_submitted(self, workflow):
            raise AssertionError("submit() must never be called when SAM3 is unavailable")

        monkeypatch.setattr(ComfyUIClient, "submit", _fail_if_submitted)
        monkeypatch.setattr(sys, "argv", ["gen_master_sheet_part_cutouts_T0417.py"])

        gen.main()

        written = json.loads((evidence_dir / "part_comparison.json").read_text())
        assert written["sam3_availability"]["available"] is False
        assert written["panels"] == existing_panels


class _UploadFailsStubClient:
    """Records whether the SAM3 submission surface (`submit`/
    `wait_for_completion`/`fetch_output`) was ever reached after
    `upload_image` fails -- the exact question Finding 1 is about.
    `upload_image` always raises `UploadError`; the other three methods
    just count their own calls so a test can assert they stayed at zero."""

    def __init__(self):
        self.submit_calls = 0
        self.wait_calls = 0
        self.fetch_calls = 0

    def upload_image(self, data: bytes, filename: str) -> None:
        from comfy_client.errors import UploadError

        raise UploadError("simulated upload failure")

    def submit(self, workflow: dict) -> str:
        self.submit_calls += 1
        return "job-1"

    def wait_for_completion(self, job_id: str, timeout: float = 60.0) -> dict:
        self.wait_calls += 1
        return {"job_id": job_id}

    def fetch_output(self, result: dict) -> bytes:
        self.fetch_calls += 1
        arr = np.zeros((PANEL_SIZE, PANEL_SIZE), dtype=np.uint8)
        buf = io.BytesIO()
        Image.fromarray(arr, mode="L").save(buf, format="PNG")
        return buf.getvalue()


class TestUploadFailureAbortsThePartRequest:
    """FIX ROUND finding 1 -- `gen_master_sheet_part_cutouts_T0417.py:330-333`
    caught `UploadError`, printed it, and submitted the SAM3 graph anyway
    against the fixed filename `T0417_panel_legs.png`: an upload failure
    does not imply the submission fails, so ComfyUI could still hold a
    PRIOR image under that name and segment stale pixels while the local
    overlay/descent/provenance all identify the current crop. The
    reviewer's stub raising `UploadError` confirmed the segmentation
    runner was still called and returned a normal SAM3 result.

    Reproduced directly against the production `_run_one_part` -- no local
    stand-in for the function under test."""

    def test_upload_error_aborts_before_the_runner_is_invoked(self, tmp_path, monkeypatch):
        import pytest

        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        monkeypatch.setattr(gen, "EVIDENCE_DIR", evidence_dir)

        client = _UploadFailsStubClient()
        crop = Image.new("RGB", (PANEL_SIZE, PANEL_SIZE), (0, 0, 0))
        points = rig.keypoints_for("legs")
        palette_list = [(0, 0, 0), (255, 255, 255)]

        with pytest.raises(gen.Sam3SegmentationUnavailable):
            gen._run_one_part(
                client,
                crop,
                "T0417_panel_legs.png",
                "legs",
                "right_upper_leg",
                points,
                palette_list,
                "run-1",
            )

        # The runner (submit/wait_for_completion/fetch_output) is never
        # reached -- this is what would have caught the withdrawn shape,
        # which called it regardless of the upload outcome.
        assert client.submit_calls == 0
        assert client.wait_calls == 0
        assert client.fetch_calls == 0

        # No mask, overlay, descended PNG or success-shaped provenance for
        # this part -- an aborted request must not leave anything that
        # looks like a real segmentation.
        assert not (evidence_dir / "panel_legs_part_right_upper_leg_mask.png").exists()
        assert not (evidence_dir / "panel_legs_part_right_upper_leg_sam3_after.png").exists()
        assert not (evidence_dir / "panel_legs_part_right_upper_leg_descended.png").exists()
        assert not (
            evidence_dir / "panel_legs_part_right_upper_leg_descended.provenance.json"
        ).exists()


def _write_tiny_mask_png(path):
    arr = np.zeros((4, 4), dtype=np.uint8)
    arr[0:2, 0:2] = 255
    Image.fromarray(arr, mode="L").save(path)


class TestMainCatchesMidRunSam3Unavailable:
    """FIX ROUND finding 2 -- `_make_part_sam3_runner` already turns a
    submission/execution/timeout/fetch failure (or, after the finding-1
    fix, an upload failure) into `Sam3SegmentationUnavailable`, but
    `main()` never caught it around `_run_one_part`. A host that passes
    the initial probe and then fails during inference used to terminate
    the script without recording an unavailable prerequisite, leaving the
    previous comparison on disk with `sam3_availability.available=true`
    and older sibling results standing next to it unlabelled.

    `_run_one_part` itself is monkeypatched here -- its own correctness
    (including finding 1's abort path) is covered by
    `TestUploadFailureAbortsThePartRequest` above; this class is only
    about what `main()`'s driver loop does with the exception once it's
    raised, which is a different code path from the one that raises it."""

    def _patch_probe_and_argv(self, monkeypatch):
        monkeypatch.setattr(
            gen,
            "_probe_sam3_availability",
            lambda client: ({"available": True, "reason": None}, None),
        )
        monkeypatch.setattr(sys, "argv", ["gen_master_sheet_part_cutouts_T0417.py"])

    def test_failure_on_the_first_part_records_prerequisite_no_partial_success_file(
        self, tmp_path, monkeypatch
    ):
        evidence_dir = tmp_path / "evidence"
        monkeypatch.setattr(gen, "EVIDENCE_DIR", evidence_dir)
        self._patch_probe_and_argv(monkeypatch)

        def _fail(*args, **kwargs):
            raise gen.Sam3SegmentationUnavailable("simulated: submit failed")

        monkeypatch.setattr(gen, "_run_one_part", _fail)

        gen.main()

        written = json.loads((evidence_dir / "part_comparison.json").read_text())
        # Does not leave sam3_availability.available=true standing next to
        # stale/absent results -- the initial probe passed, but this run's
        # own comparison did not complete.
        assert written["sam3_availability"]["available"] is False
        assert written["sam3_mid_run_failure"]["panel"] == "legs"
        assert written["sam3_mid_run_failure"]["part"] == "right_upper_leg"
        assert "submit failed" in written["sam3_mid_run_failure"]["reason"]
        # First part ever attempted failed -- no partial-success record, and
        # specifically not an empty-but-successful-looking file (the empty
        # panels dict is explicitly tied to a recorded mid-run failure, not
        # silently presented as "nothing to report").
        assert written["panels"] == {}
        assert written["panels_historical"] is True

    def test_failure_after_one_part_already_completed_retains_it_as_historical(
        self, tmp_path, monkeypatch
    ):
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        monkeypatch.setattr(gen, "EVIDENCE_DIR", evidence_dir)
        self._patch_probe_and_argv(monkeypatch)

        mask_path = evidence_dir / "panel_legs_part_right_upper_leg_mask.png"
        _write_tiny_mask_png(mask_path)
        completed_result = {
            "panel": "legs",
            "part": "right_upper_leg",
            "present": True,
            "isolated": True,
            "isolated_before_overlap": True,
            "overlap_exceeds_tolerance": False,
            "mask": str(mask_path),
        }
        calls = {"n": 0}

        def _first_ok_then_fail(
            client, crop, image_filename, panel_key, part_key, points, palette_list, run_id
        ):
            calls["n"] += 1
            if calls["n"] == 1:
                return dict(completed_result, part=part_key)
            raise gen.Sam3SegmentationUnavailable("simulated: fetch_output failed")

        monkeypatch.setattr(gen, "_run_one_part", _first_ok_then_fail)

        gen.main()

        written = json.loads((evidence_dir / "part_comparison.json").read_text())
        assert written["sam3_availability"]["available"] is False
        assert written["sam3_mid_run_failure"]["part"] == "right_lower_leg"
        assert "fetch_output failed" in written["sam3_mid_run_failure"]["reason"]
        # This must NOT reintroduce the destructive overwrite round 1 fixed:
        # the part that already completed this run stays on record...
        assert written["panels"]["legs"]["parts"]["right_upper_leg"]["present"] is True
        # ...but explicitly flagged historical, not silently presented as a
        # fresh, complete comparison for this run.
        assert written["panels_historical"] is True


class TestAllPartPairsOverlapEvaluation:
    """FIX ROUND finding 3 -- `SIBLING_PART_PAIRS_BY_PANEL` checked only
    same-side `upper_leg`/`lower_leg` and `lower_leg`/`boot`. Cross-side
    pairs and `upper_leg`/`boot` were excluded as "never physically
    adjacent" -- and that assumption is exactly what a failed segmentation
    violates. The reviewer's probe supplied identical left/right
    upper-leg masks: actual overlap 1.0, `_evaluate_overlaps` returned [],
    and both verdicts stayed `isolated=true`.

    Reproduced directly against `_evaluate_overlaps` + `_apply_overlap_rejection`,
    the same two production functions `main()` itself calls."""

    def test_identical_cross_side_upper_leg_masks_are_rejected(self):
        mask = np.zeros((64, 64), dtype=bool)
        mask[10:40, 10:40] = True
        masks_by_part = {
            "right_upper_leg": mask.copy(),
            "left_upper_leg": mask.copy(),
        }

        overlaps = gen._evaluate_overlaps("legs", masks_by_part)
        pairs_found = {frozenset((o["part_a"], o["part_b"])) for o in overlaps}
        target = frozenset(("right_upper_leg", "left_upper_leg"))
        assert target in pairs_found, overlaps
        cross_pair = next(
            o for o in overlaps if frozenset((o["part_a"], o["part_b"])) == target
        )
        assert cross_pair["overlap_fraction"] == 1.0
        assert cross_pair["exceeds_tolerance"] is True

        parts = {
            "right_upper_leg": {
                "present": True,
                "isolated": True,
                "isolated_before_overlap": True,
                "overlap_exceeds_tolerance": False,
            },
            "left_upper_leg": {
                "present": True,
                "isolated": True,
                "isolated_before_overlap": True,
                "overlap_exceeds_tolerance": False,
            },
        }
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is False
        assert updated["left_upper_leg"]["isolated"] is False

    def test_same_side_non_adjacent_upper_leg_and_boot_pair_is_also_evaluated(self):
        # upper_leg/boot on the SAME side never shares a joint either, so
        # it was excluded from SIBLING_PART_PAIRS_BY_PANEL just like the
        # cross-side pairs -- any pair outside that explicit adjacency list
        # gets zero tolerance, not a silent skip.
        mask_a = np.zeros((64, 64), dtype=bool)
        mask_a[0:20, 0:20] = True
        mask_b = np.zeros((64, 64), dtype=bool)
        mask_b[0:20, 0:20] = True
        masks_by_part = {"right_upper_leg": mask_a, "right_boot": mask_b}

        overlaps = gen._evaluate_overlaps("legs", masks_by_part)
        target = frozenset(("right_upper_leg", "right_boot"))
        pair = next(o for o in overlaps if frozenset((o["part_a"], o["part_b"])) == target)
        assert pair["tolerance"] == 0.0
        assert pair["exceeds_tolerance"] is True

    def test_three_way_mutual_overlap_rejects_every_part_involved(self):
        # "Three or more parts overlapping mutually" edge case: every part
        # that appears in ANY exceeding pair is rejected, not just the
        # first pair found.
        mask = np.zeros((64, 64), dtype=bool)
        mask[0:20, 0:20] = True
        masks_by_part = {
            "right_upper_leg": mask.copy(),
            "left_upper_leg": mask.copy(),
            "left_lower_leg": mask.copy(),
        }
        overlaps = gen._evaluate_overlaps("legs", masks_by_part)
        parts = {
            key: {
                "present": True,
                "isolated": True,
                "isolated_before_overlap": True,
                "overlap_exceeds_tolerance": False,
            }
            for key in masks_by_part
        }
        updated = gen._apply_overlap_rejection(parts, overlaps)
        assert updated["right_upper_leg"]["isolated"] is False
        assert updated["left_upper_leg"]["isolated"] is False
        assert updated["left_lower_leg"]["isolated"] is False

    def test_adjacent_pair_keeps_the_existing_joint_blur_tolerance(self):
        # A genuinely adjacent pair (thigh/lower-leg sharing the knee) keeps
        # PART_OVERLAP_FRACTION_TOLERANCE (0.25) -- some boundary blur near
        # the shared joint is expected and must not be rejected outright.
        mask_a = np.zeros((64, 64), dtype=bool)
        mask_a[0:45, :] = True  # 2880 px
        mask_b = np.zeros((64, 64), dtype=bool)
        mask_b[44:54, :] = True  # 640 px, overlaps mask_a in row 44 only
        masks_by_part = {"right_upper_leg": mask_a, "right_lower_leg": mask_b}

        overlaps = gen._evaluate_overlaps("legs", masks_by_part)
        target = frozenset(("right_upper_leg", "right_lower_leg"))
        pair = next(o for o in overlaps if frozenset((o["part_a"], o["part_b"])) == target)
        assert pair["tolerance"] == gen.PART_OVERLAP_FRACTION_TOLERANCE
        assert abs(pair["overlap_fraction"] - 0.1) < 1e-9
        assert pair["exceeds_tolerance"] is False

    def test_absent_part_never_appears_in_masks_by_part_is_excluded(self):
        # "A part legitimately absent (empty mask)... it is excluded from
        # overlap evaluation rather than counted as a 0-overlap pass" --
        # masks_by_part only ever contains present parts (main() filters
        # on res.get("present") before building it), so this just confirms
        # _evaluate_overlaps doesn't require every PARTS_BY_PANEL key.
        masks_by_part = {"right_boot": np.zeros((64, 64), dtype=bool)}
        overlaps = gen._evaluate_overlaps("legs", masks_by_part)
        assert overlaps == []
