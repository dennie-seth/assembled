# T-0227 — Character-pipeline bake-off cost record (template)

**Author:** Claude (Opus 5)
**Pre-registered with:** `docs/decision-log.md` DL-21 (HANDOFF §23-c)
**Filled in by:** §23-d (Arm A), §23-e (Arm B), §23-f (Arm C — the script)
**Consumed by:** §23-g

---

## How to use this

Every arm fills in **this same table** — same columns, same units, same rules — so the
§23-g cost table is comparable **by construction** rather than reconciled afterwards.
Copy the table below into the arm's own card/report and fill your arm's row; §23-g
concatenates the three rows unchanged.

Do not add, rename, drop, or reorder columns. A column an arm cannot fill is recorded as
`n/a` with a one-line reason in **Notes**, never left blank and never replaced with a
different measure.

**Fill the verdict columns before the cost columns.** Criterion 1 and Criterion 2 take
strict precedence over cost (DL-21): an arm that fails Criterion 1 is eliminated, and its
cost row is recorded for the log but plays no part in choosing the winner. Recording cost
next to the verdicts is what stops a cheap eliminated arm from being read as the winner.

---

## The table

| Arm | Criterion 1 (silhouette @ 40px in motion) | Criterion 2 (identity stable) | Attempts-to-first-pass | GPU minutes | Wall-clock | $ | Sheet | Provenance sidecar | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Arm A (§23-d) | PASS / FAIL | PASS / FAIL | n / 8 | | | | | | |
| Arm B (§23-e) | PASS / FAIL | PASS / FAIL | n / 8 | | | | | | |
| Arm C (§23-f, the script) | PASS / FAIL | PASS / FAIL | n / 8 | | | | | | |

---

## Column definitions — identical for all three arms

| Column | Definition | Units |
|---|---|---|
| **Criterion 1 (silhouette @ 40px in motion)** | Human pass/fail, judged at 40px in motion inside the T-0192 blockout room: is it a person, which way is it facing, what is it doing? A FAIL eliminates the arm. | `PASS` / `FAIL` |
| **Criterion 2 (identity stable)** | Frame-silhouette delta gate over adjacent frames **plus** the human drift verdict. Both must pass; record the gate's numeric delta in Notes. | `PASS` / `FAIL` |
| **Attempts-to-first-pass** | Attempts consumed before the first sheet that passes criteria 1 and 2 at the DL-21 output spec. Capped at **8**; `8/8` with no pass is recorded as a **criterion-3 failure**, not as "no result". | integer `n / 8` |
| **GPU minutes** | Wall-clock GPU-busy minutes summed across **every** attempt, not just the passing one — including discarded generations. Excludes model download / one-time environment setup; note any such exclusion. | minutes, 1 decimal |
| **Wall-clock** | Elapsed human time from the arm starting to the passing sheet being committed, summed across attempts. Includes waiting, curation, and re-runs. | `HH:MM` |
| **$** | Direct out-of-pocket spend (rented GPU, API calls). Local-GPU arms record `$0.00` and put the electricity/opportunity-cost caveat in Notes — never estimate a notional local cost, since a fabricated number is not comparable across arms. | `$0.00` |
| **Sheet** | Repo path of the committed 144x144 indexed sheet. | path |
| **Provenance sidecar** | Repo path of the P-7-compliant sidecar (`generator` resolves to committed code, `model_hash` non-null, `concept_hash` resolves to T-0209's sheet). | path |
| **Notes** | Anything a reader of the §23-g table would otherwise have to ask about: the criterion-2 delta value, `n/a` reasons, exclusions, failure mode on an eliminated arm. | prose |

---

## Rules that keep the rows comparable

- **Count every attempt, not just the good one.** An arm that burned six attempts before
  a pass costs six attempts' GPU minutes. Reporting only the winning run is the single
  easiest way to make an expensive arm look cheap.
- **An eliminated arm still files a complete row.** Criterion-1 failure ends the arm's
  candidacy, not its bookkeeping — §23-g needs to show what the rejected paths cost.
- **The cap is a result.** Reaching `8/8` without a pass is filed as a criterion-3
  failure with all cost columns filled, and closes the arm.
- **No back-filled estimates.** A number nobody measured is recorded as `n/a` with a
  reason. An estimate that reads like a measurement is worse than a gap.
