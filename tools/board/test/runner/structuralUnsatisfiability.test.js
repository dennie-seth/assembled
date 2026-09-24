import { describe, it, expect } from "vitest";
import {
  classifyAcceptanceItem,
  classifyAcceptanceItems,
  ORCHESTRATOR_ONLY_ACTION_PATTERNS
} from "../../src/runner/structuralUnsatisfiability.js";

describe("classifyAcceptanceItem -- claude-dir-edit class (T-0405)", () => {
  it("flags a criterion requiring an edit under .claude/**", () => {
    const result = classifyAcceptanceItem(
      "`.claude/rules/planner.md` and `.claude/agents/planner.md` are edited to document the new convention.",
      { agentName: "infra", taskStoreKind: "db" }
    );
    expect(result).not.toBeNull();
    expect(result.classId).toBe("claude-dir-edit");
    expect(result.owner).toBe("human");
    expect(result.reason).toMatch(/sensitive-file protection/i);
    expect(result.reason).toContain(".claude/rules/planner.md");
  });

  it("does not flag a mere read/mention of a .claude/ path with no edit cue", () => {
    const result = classifyAcceptanceItem(
      "The reviewer loads `.claude/rules/conduct.md` before auditing the diff.",
      { agentName: "infra", taskStoreKind: "db" }
    );
    expect(result).toBeNull();
  });

  it("applies regardless of which agent is running -- the harness denial is universal", () => {
    // infra's own nominal path scope includes .claude/** (see .claude/agents/infra.md), but the
    // CLI's sensitive-file protection still refuses the Edit/Write outright in an unattended run.
    const result = classifyAcceptanceItem("`.claude/agents/infra.md` is updated with the new grant.", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).not.toBeNull();
    expect(result.classId).toBe("claude-dir-edit");
  });
});

describe("classifyAcceptanceItem -- card-body-authorship class (T-0403)", () => {
  it("flags a criterion requiring content in the card's own body for a db-mode implementer", () => {
    const result = classifyAcceptanceItem(
      "An **Edge cases:** block, with its own `- [ ]` checklist items, is present in this card's own body.",
      { agentName: "infra", taskStoreKind: "db" }
    );
    expect(result).not.toBeNull();
    expect(result.classId).toBe("card-body-authorship");
    expect(result.owner).toBe("planner");
    expect(result.reason).toMatch(/materializ/i);
  });

  it("does NOT flag the identical wording in fs mode -- the file genuinely exists to edit", () => {
    const result = classifyAcceptanceItem("An **Edge cases:** block is present in this card's own body.", {
      agentName: "infra",
      taskStoreKind: "fs"
    });
    expect(result).toBeNull();
  });

  it("does NOT flag the identical wording for the planner agent -- it keys on the running agent, not the wording", () => {
    const result = classifyAcceptanceItem("An **Edge cases:** block is present in this card's own body.", {
      agentName: "planner",
      taskStoreKind: "db"
    });
    expect(result).toBeNull();
  });

  it("does not flag an ordinary criterion with no card-body phrasing", () => {
    const result = classifyAcceptanceItem("Door and ladder geometry stays walkable after the remap.", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).toBeNull();
  });
});

describe("classifyAcceptanceItem -- orchestrator-only-action class (push/PR/CI, T-0384/T-0365)", () => {
  it("flags active-voice 'open a pull request'", () => {
    const result = classifyAcceptanceItem("Commit + open a PR. Do NOT merge.", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).not.toBeNull();
    expect(result.classId).toBe("orchestrator-only-action");
    expect(result.owner).toBe("board");
  });

  it("flags passive-voice 'a PR is opened with CI green' (T-0258)", () => {
    const result = classifyAcceptanceItem("A PR is opened with CI green before this card is considered done", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).not.toBeNull();
    expect(result.classId).toBe("orchestrator-only-action");
  });

  it("flags a merge requirement and attributes it to a human, not the board", () => {
    const result = classifyAcceptanceItem("The PR is merged into develop.", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).not.toBeNull();
    expect(result.owner).toBe("human");
  });

  it("does not flag an ordinary criterion mentioning neither push, PR, nor CI", () => {
    const result = classifyAcceptanceItem("`npx vitest run` and `npx eslint .` both pass.", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).toBeNull();
  });

  it("exports its pattern table for reuse by impossibleAcceptancePreflight.js", () => {
    expect(Array.isArray(ORCHESTRATOR_ONLY_ACTION_PATTERNS)).toBe(true);
    expect(ORCHESTRATOR_ONLY_ACTION_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("classifyAcceptanceItem -- ordinary unmet items are never classified", () => {
  it("returns null for a criterion the agent simply didn't do, however it's worded", () => {
    const result = classifyAcceptanceItem("The new endpoint returns a 404 for an unknown id.", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).toBeNull();
  });

  it("returns null for a criterion phrased with a common word like 'confirm'/'verify'", () => {
    const result = classifyAcceptanceItem("Confirm `npx vitest run` reports all green.", {
      agentName: "infra",
      taskStoreKind: "db"
    });
    expect(result).toBeNull();
  });
});

describe("classifyAcceptanceItems -- batch helper", () => {
  it("classifies each item independently and preserves item order/shape", () => {
    const items = [
      { text: "`npx vitest run` is green.", checked: false },
      { text: "`.claude/agents/infra.md` is updated with the new grant.", checked: false }
    ];
    const result = classifyAcceptanceItems(items, { agentName: "infra", taskStoreKind: "db" });
    expect(result).toHaveLength(2);
    expect(result[0].classification).toBeNull();
    expect(result[0].text).toBe(items[0].text);
    expect(result[1].classification).not.toBeNull();
    expect(result[1].classification.classId).toBe("claude-dir-edit");
  });

  it("returns an empty array for an empty item list", () => {
    expect(classifyAcceptanceItems([], { agentName: "infra", taskStoreKind: "db" })).toEqual([]);
  });
});
