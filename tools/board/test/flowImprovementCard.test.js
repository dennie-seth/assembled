import { describe, it, expect } from "vitest";
import {
  draftImprovementCard,
  extractBaselineDone,
  isAutoProposedCard
} from "../src/lib/flowImprovementCard.js";
import { parseTask, serializeTask } from "../src/lib/taskParser.js";

const baseStats = {
  totalCards: 20,
  byStatus: {
    backlog: 2,
    ready: 1,
    "in-progress": 1,
    validation: 0,
    review: 1,
    done: 12,
    blocked: 3,
    retired: 0
  },
  reworkTotal: 6,
  passTotal: 4,
  reworkRate: 0.6,
  reworkSample: 10,
  recoveredTotal: 2,
  retryCapBlockedCount: 2,
  avgReworkPerDoneCard: 0.5
};

describe("draftImprovementCard", () => {
  it("produces a card that satisfies taskParser's schema end-to-end (round-trips through serialize/parse)", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: { reason: "interval", doneDelta: 10, baselineDone: 2 },
      now: () => new Date("2026-08-06T00:00:00.000Z")
    });

    const withRequiredFields = {
      id: "T-9001",
      created: "2026-08-06",
      depends_on: [],
      ...draft
    };
    const serialized = serializeTask(withRequiredFields);
    const parsed = parseTask(serialized);

    expect(parsed.title).toBe(draft.title);
    expect(parsed.status).toBe("backlog");
    expect(parsed.agent).toBeNull();
    expect(parsed.deliverable_type).toBe("code");
  });

  it("always sets status: backlog and agent: null regardless of trigger reason", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: { reason: "rework-rate", reworkRate: 0.6, reworkSample: 10, baselineDone: 12 }
    });

    expect(draft.status).toBe("backlog");
    expect(draft.agent).toBeNull();
  });

  it("embeds a baseline-done marker in the body equal to the current done count", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: { reason: "interval", doneDelta: 10, baselineDone: 2 }
    });

    expect(extractBaselineDone(draft.body)).toBe(baseStats.byStatus.done);
  });

  it("mentions the concrete numbers that crossed threshold for an interval trigger", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: { reason: "interval", doneDelta: 10, baselineDone: 2 }
    });

    expect(draft.title).toMatch(/10/);
    expect(draft.body).toContain(String(baseStats.reworkTotal));
    expect(draft.body).toContain(String(baseStats.byStatus.blocked));
  });

  it("mentions the rework rate for a rework-rate trigger", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: { reason: "rework-rate", reworkRate: 0.6, reworkSample: 10, baselineDone: 12 }
    });

    expect(draft.title).toMatch(/60%|0\.6/);
  });

  it("writes an Acceptance section requiring a root cause and a following measurement, not just a vague 'improve flow'", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: { reason: "interval", doneDelta: 10, baselineDone: 2 }
    });

    expect(draft.body).toMatch(/## Acceptance/);
    expect(draft.body).toMatch(/root cause/i);
  });

  it("is marked recognizable as an auto-proposed card via isAutoProposedCard", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: { reason: "interval", doneDelta: 10, baselineDone: 2 }
    });

    expect(isAutoProposedCard({ body: draft.body })).toBe(true);
    expect(isAutoProposedCard({ body: "no marker here" })).toBe(false);
    expect(isAutoProposedCard({})).toBe(false);
  });
});

describe("extractBaselineDone", () => {
  it("returns null when no marker is present", () => {
    expect(extractBaselineDone("## Context\n\nnothing here\n")).toBeNull();
  });

  it("parses the marker's numeric value", () => {
    const body = "<!-- flow-stats-self-improve: baseline-done=42 -->\n\n## Context\n";
    expect(extractBaselineDone(body)).toBe(42);
  });
});
