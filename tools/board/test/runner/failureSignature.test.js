import { describe, it, expect } from "vitest";
import {
  computeFailureSignature,
  normalizeFailureText
} from "../../src/runner/failureSignature.js";

describe("normalizeFailureText", () => {
  it("strips timestamps, pids, run ids, and worktree paths", () => {
    const normalized = normalizeFailureText(
      "Failed at 2026-08-24T10:15:30.123Z (pid 12345) in /repo/worktrees/T-0224/foo.js (run-id abc-123-def) after 12.3s"
    );
    expect(normalized).not.toMatch(/2026-08-24/);
    expect(normalized).not.toMatch(/12345/);
    expect(normalized).not.toMatch(/worktrees\/T-0224/);
    expect(normalized).not.toMatch(/abc-123-def/);
    expect(normalized).not.toMatch(/12\.3s/);
  });

  it("leaves the stable error text intact", () => {
    const normalized = normalizeFailureText("assertion failed: expected 3 but received 2 in boardView.test.js:44");
    expect(normalized).toContain("assertion failed");
    expect(normalized).toContain("boardView.test.js:44");
  });

  it("returns an empty string for non-string input", () => {
    expect(normalizeFailureText(undefined)).toBe("");
    expect(normalizeFailureText(null)).toBe("");
  });
});

// The whole `computeFailureSignature` contract moved off the reviewer's prose and onto the
// worktree's git state -- see the state-based block below, and failureSignature.js for why.
// `normalizeFailureText` is still exercised above (it now cleans the porcelain status rather
// than a reviewer note), but a signature can no longer be produced from notes alone.
describe("computeFailureSignature -- notes are no longer a basis", () => {
  it("returns null when given only notes, however distinctive they are", () => {
    expect(
      computeFailureSignature({
        phase: "reviewer",
        verdict: "FAIL",
        notes: "assertion failed in thing.test.js"
      })
    ).toBeNull();
  });

  it("cannot be made to differ by the notes when the state is the same", () => {
    const state = { head: "e".repeat(40), tree: "f".repeat(40), dirty: "" };
    const a = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state, notes: "assertion failed" });
    const b = computeFailureSignature({
      phase: "reviewer",
      verdict: "FAIL",
      state,
      notes: "permission denied writing to /etc/hosts"
    });
    expect(a).toBe(b);
  });
});


// ---------------------------------------------------------------------------
// The signature is computed from the attempt's RESULT, not the reviewer's prose.
//
// T-0229 burned all five retry slots on eight consecutive FAILs whose branch state
// the reviewer itself called "byte-identical to runs 2-7". The abort never fired
// because the signature hashed the reviewer's free-text notes, and those notes
// carry an incrementing ordinal ("Third consecutive FAIL", ... "Eighth consecutive
// FAIL"), so every attempt hashed differently by construction. Basing the signature
// on the worktree's actual git state removes the whole class: prose cannot vary it,
// and two attempts that leave identical tracked state are identical by definition.
// ---------------------------------------------------------------------------

const STATE_A = { head: "a".repeat(40), tree: "1".repeat(40), dirty: "" };
const STATE_B = { head: "b".repeat(40), tree: "2".repeat(40), dirty: "" };

describe("computeFailureSignature -- state-based", () => {
  it("hashes two attempts with identical state equal, even when the notes differ wildly", () => {
    const first = computeFailureSignature({
      phase: "reviewer",
      verdict: "FAIL",
      state: STATE_A,
      notes: "Third consecutive FAIL; state byte-identical to run 2."
    });
    const second = computeFailureSignature({
      phase: "reviewer",
      verdict: "FAIL",
      state: STATE_A,
      notes: "Eighth consecutive FAIL; I re-verified independently and it is byte-identical to runs 2-7."
    });

    expect(first).toBe(second);
  });

  it("ignores the notes entirely -- they cannot change the signature", () => {
    const withNotes = computeFailureSignature({
      phase: "reviewer",
      verdict: "FAIL",
      state: STATE_A,
      notes: "completely different prose, commit ee5d6e0, 35 files"
    });
    const withoutNotes = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_A });

    expect(withNotes).toBe(withoutNotes);
  });

  it("hashes differently when the branch actually moved -- real progress is not an abort", () => {
    const before = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_A });
    const after = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_B });

    expect(before).not.toBe(after);
  });

  it("hashes differently when only uncommitted work appeared", () => {
    const clean = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_A });
    const dirty = computeFailureSignature({
      phase: "reviewer",
      verdict: "FAIL",
      state: { ...STATE_A, dirty: " M assets/src/character/gen_arm_b_idle_T0229.py" }
    });

    expect(clean).not.toBe(dirty);
  });

  it("keeps the verdict category in the basis", () => {
    const fail = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_A });
    const other = computeFailureSignature({ phase: "reviewer", verdict: "BLOCKED", state: STATE_A });

    expect(fail).not.toBe(other);
  });

  it("keeps the phase in the basis", () => {
    const reviewer = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_A });
    const implementer = computeFailureSignature({ phase: "implementer", verdict: "FAIL", state: STATE_A });

    expect(reviewer).not.toBe(implementer);
  });

  it("returns null when the git state could not be read -- no state, no comparison", () => {
    expect(computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: null })).toBeNull();
    expect(computeFailureSignature({ phase: "reviewer", verdict: "FAIL" })).toBeNull();
  });

  it("is a stable sha256 hex digest", () => {
    const sig = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_A });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFailureSignature({ phase: "reviewer", verdict: "FAIL", state: STATE_A })).toBe(sig);
  });
});
