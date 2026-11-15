# T-0437 fix round 2 -- `character-gate-report` attempt log

Per the FIX ROUND 2 edge case: "If the per-sheet gate fails on a check unrelated to the arm
fix ... the failing output is pasted into the card and the card stops -- it does not get made
to pass by editing the sidecar's recorded values." This is that paste.

## What was done

1. **`docs/assets/evidence/T-0437/idle_canonical_rig.provenance.json` was written**, by a new
   script, `assets/src/character/gen_idle_canonical_rig_provenance_T0437.py`, which opens the
   **already-committed** `idle_canonical_rig.png` read-only and measures it -- it does not call
   `char_gen.idle_cycle` or re-render anything. It builds `frame_delta_range`,
   `arm_c_benchmark`, `beats_arm_c_benchmark` via the project's own
   `comfy_client.provenance_sidecar.apply_arm_c_benchmark_fields`, `motion_class: "idle"`,
   `generator` naming the actual render script
   (`assets/src/character/gen_idle_canonical_rig_evidence_T0437.py`), `generator_hash` = that
   file's real sha256, and `model_hash: null` (zero-GPU deterministic composite, the same
   convention several `assets/final/entity/*.provenance.json` sidecars already use).

2. **Neither PNG was regenerated.** At the branch head:

   ```
   $ sha256sum docs/assets/evidence/T-0437/idle_canonical_rig.png
   3ced2018ae91d32f30e613917ad07feab4231fbfa4df6c510f2fee12cb7000df  docs/assets/evidence/T-0437/idle_canonical_rig.png
   $ sha256sum docs/assets/evidence/T-0437/idle_draw_order.png
   34c398f38a917e8ae1bbca00b25aadc44427e5d7712cccd016be69bc64a86ec1  docs/assets/evidence/T-0437/idle_draw_order.png
   ```

   Both match the hashes Codex's final review named exactly.

3. **`generator_hash` was verified against the real file**, not hand-written:

   ```
   $ sha256sum assets/src/character/gen_idle_canonical_rig_evidence_T0437.py
   fa867efafb4ff048555283f194b183f1d8b13dd8b06a9219721c154875fa1780  assets/src/character/gen_idle_canonical_rig_evidence_T0437.py
   ```

   This equals the sidecar's `generator_hash` field.

4. **Sheet geometry** (`--cols 12 --rows 1 --cell-px 48`) comes from the generator's own call
   chain, not eyeballing: `gen_idle_canonical_rig_evidence_T0437.py` calls
   `idle_cycle.render_frames(frame_count=12)`, whose default `cell_px` is
   `char_gen.character_scale.CELL_PX` (= 48), and `rig_compositor.save_sheet` lays every frame
   into a single row (`cell_w * len(frames)` wide, `cell_h` tall) -- i.e. 12 cols x 1 row x 48px.
   This is confirmed against the actual committed file: `Image.open(...).size == (576, 48)` ==
   `12 * 48, 1 * 48`.

## What failed, and why it is NOT a this-round regression

Running the exact command the card specifies:

```
python -m asset_gate.cli character-gate-report docs/assets/evidence/T-0437/idle_canonical_rig.png \
  --provenance docs/assets/evidence/T-0437/idle_canonical_rig.provenance.json \
  --cols 12 --rows 1 --cell-px 48 --repo-root . \
  --out docs/assets/evidence/T-0437/idle_canonical_rig.gate_report.json
```

crashes before producing a report:

```
Traceback (most recent call last):
  ...
  File ".../tools/asset-gate/src/asset_gate/character.py", line 532, in build_character_gate_report
    pixel_delta_count = art.count_pixel_deltas(frames[a], frames[b])
  File ".../tools/asset-gate/src/asset_gate/art.py", line 232, in count_pixel_deltas
    a, b = _to_array(frame_a), _to_array(frame_b)
  File ".../tools/asset-gate/src/asset_gate/art.py", line 24, in _to_array
    raise ValueError(f"expected an indexed (mode 'P') image, got mode {image.mode!r}")
ValueError: expected an indexed (mode 'P') image, got mode 'RGBA'
```

**Root cause:** `idle_canonical_rig.png` is RGBA. `char_gen.rig_compositor.save_sheet`
(`idle_cycle`'s own render path) composites frames with `Image.alpha_composite` and never
palette-quantizes -- correct for a `docs/assets/evidence/**` record, which this card's own
"Deliverable" section asks for as a plain render, not a curated `assets/final/` asset. But
`asset_gate.art._to_array` (and therefore `count_pixel_deltas` / `check_frame_consistency`,
which `build_character_gate_report` calls for every adjacent frame pair) hard-requires mode
`"P"` -- the same failure signature already seen as pre-existing noise on this branch's
entity-sheet gate tests (`ValueError: expected an indexed (mode 'P') image, got mode 'RGB'`,
reported in this card's own prior validation history). This is a structural mismatch between
an unquantized evidence render and a gate built for quantized finals -- not something
introduced by, or fixable from within, this round's arm-breath fix, and not fixable by editing
the sidecar: the crash happens before any provenance field is even read for a verdict.

**What this round did NOT do, on purpose:**
- Did not re-render/re-quantize `idle_canonical_rig.png` to make it indexed -- that would
  change its SHA-256 and void Codex's already-recorded verification of this exact blob.
- Did not touch `rig_compositor.py`, `idle_cycle.py`, their tests, `art.py`, or `character.py`.
- Did not fabricate a `gate_report.json` -- none exists, because the command never completed.

**Measured anyway, independently of the gate:** since `art.check_frame_consistency` could not
run on this RGBA sheet, `gen_idle_canonical_rig_provenance_T0437.py` re-implements its exact
silhouette-delta definition (`delta = count(silhouette_a != silhouette_b)`,
`union = count(silhouette_a | silhouette_b)`, `ratio = delta / union`) against the alpha
channel (`alpha != 0` as foreground -- RGBA's own direct analogue of a `P`-mode
`background_index=0`), which is what populates the sidecar's `frame_delta_range`:
`[0.0070..., 0.0405...]`, comfortably under both the idle 0.30 cap
(`asset_gate.character.IDLE_FRAME_DELTA_CAP` per `frame_delta_cap_for_motion_class`) and the
Arm-C benchmark's upper bound (0.112) -- hence `beats_arm_c_benchmark: true`.

## What is NOT satisfied by this round

- No `docs/assets/evidence/T-0437/idle_canonical_rig.gate_report.json` exists, and no
  `character-gate-report` invocation against this exact sheet exits 0 -- the acceptance
  criteria asking for a committed, exit-0 report are **not met**, for the structural reason
  above, not for lack of trying.
- This is a gap in the gate's handling of non-quantized `docs/assets/evidence/**` renders,
  which is outside this card's stated scope (`idle_cycle.py`, its tests, and one evidence
  render -- not `asset_gate`). A human decision is needed on whether the per-sheet gate should
  accept RGBA evidence renders (quantize internally for the check) or whether evidence renders
  under `docs/` are simply out of this gate's scope and the CHR-1 presence check on
  `assets/final/**` outputs is what actually matters.
