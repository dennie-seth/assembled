import { describe, it, expect } from "vitest";
import {
  draftImprovementCard,
  extractBaselineDone,
  extractProposedAt,
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

const reworkTrigger = {
  reason: "rework-rate",
  reworkRate: 0.6,
  reworkSample: 10,
  baselineDone: 2,
  evidence: [
    { id: "T-0201", timestamp: "2026-08-05T00:00:00.000Z" },
    { id: "T-0202", timestamp: "2026-08-06T00:00:00.000Z" }
  ],
  windowStart: "2026-08-05T00:00:00.000Z",
  windowEnd: "2026-08-06T00:00:00.000Z"
};

const retryCapTrigger = {
  reason: "retry-cap-blocked",
  retryCapBlockedCount: 3,
  baselineDone: 2,
  evidence: [{ id: "T-0301", timestamp: "2026-08-03T00:00:00.000Z" }],
  windowStart: "2026-08-03T00:00:00.000Z",
  windowEnd: "2026-08-03T00:00:00.000Z"
};

const orphanRecoveryTrigger = {
  reason: "orphan-recovery",
  recoveredTotal: 3,
  baselineDone: 2,
  evidence: [{ id: "T-0401", timestamp: "2026-08-01T00:00:00.000Z" }],
  windowStart: "2026-08-01T00:00:00.000Z",
  windowEnd: "2026-08-01T00:00:00.000Z"
};

describe("draftImprovementCard", () => {
  it("produces a card that satisfies taskParser's schema end-to-end (round-trips through serialize/parse)", () => {
    const draft = draftImprovementCard({
      stats: baseStats,
      trigger: reworkTrigger,
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
    expect(parsed.agent).toBe("generic");
    expect(parsed.deliverable_type).toBe("code");
  });

  it("always sets status: backlog and agent: generic regardless of trigger reason", () => {
    const draft = draftImprovementCard({ stats: baseStats, trigger: retryCapTrigger });

    expect(draft.status).toBe("backlog");
    expect(draft.agent).toBe("generic");
  });

  it("embeds a baseline-done marker and a proposed-at timestamp in the body", () => {
    const now = () => new Date("2026-08-07T12:00:00.000Z");
    const draft = draftImprovementCard({ stats: baseStats, trigger: reworkTrigger, now });

    expect(extractBaselineDone(draft.body)).toBe(baseStats.byStatus.done);
    expect(extractProposedAt(draft.body)).toEqual(new Date("2026-08-07T12:00:00.000Z"));
  });

  it("mentions the rework rate for a rework-rate trigger", () => {
    const draft = draftImprovementCard({ stats: baseStats, trigger: reworkTrigger });

    expect(draft.title).toMatch(/60%|0\.6/);
  });

  it("mentions the retry-cap-blocked count for a retry-cap-blocked trigger", () => {
    const draft = draftImprovementCard({ stats: baseStats, trigger: retryCapTrigger });

    expect(draft.title).toMatch(/3/);
    expect(draft.body).toMatch(/retry-cap|retry cap/i);
  });

  it("mentions the recovered count for an orphan-recovery trigger", () => {
    const draft = draftImprovementCard({ stats: baseStats, trigger: orphanRecoveryTrigger });

    expect(draft.title).toMatch(/3/);
    expect(draft.body).toMatch(/orphan|recover/i);
  });

  it("cites the specific evidence card ids and the time window, not just aggregate numbers", () => {
    const draft = draftImprovementCard({ stats: baseStats, trigger: reworkTrigger });

    expect(draft.body).toContain("T-0201");
    expect(draft.body).toContain("T-0202");
    expect(draft.body).toContain("2026-08-05T00:00:00.000Z");
    expect(draft.body).toContain("2026-08-06T00:00:00.000Z");
  });

  it("includes a concrete suggested direction tailored to the trigger reason, not a generic 'improve flow' line", () => {
    const reworkDraft = draftImprovementCard({ stats: baseStats, trigger: reworkTrigger });
    const retryCapDraft = draftImprovementCard({ stats: baseStats, trigger: retryCapTrigger });

    expect(reworkDraft.body).toMatch(/Suggested direction/);
    expect(retryCapDraft.body).toMatch(/Suggested direction/);
    expect(reworkDraft.body).not.toBe(retryCapDraft.body);
  });

  it("writes an Acceptance section requiring a root cause and a following measurement, not just a vague 'improve flow'", () => {
    const draft = draftImprovementCard({ stats: baseStats, trigger: reworkTrigger });

    expect(draft.body).toMatch(/## Acceptance/);
    expect(draft.body).toMatch(/root cause/i);
  });

  it("is marked recognizable as an auto-proposed card via isAutoProposedCard", () => {
    const draft = draftImprovementCard({ stats: baseStats, trigger: reworkTrigger });

    expect(isAutoProposedCard({ body: draft.body })).toBe(true);
    expect(isAutoProposedCard({ body: "no marker here" })).toBe(false);
    expect(isAutoProposedCard({})).toBe(false);
  });
});

describe("extractBaselineDone", () => {
  it("returns null when no marker is present", () => {
    expect(extractBaselineDone("## Context\n\nnothing here\n")).toBeNull();
  });

  it("parses the marker's numeric value with no proposed-at (legacy marker)", () => {
    const body = "<!-- flow-stats-self-improve: baseline-done=42 -->\n\n## Context\n";
    expect(extractBaselineDone(body)).toBe(42);
  });

  it("parses the marker's numeric value alongside a proposed-at timestamp", () => {
    const body = "<!-- flow-stats-self-improve: baseline-done=42 proposed-at=2026-08-07T00:00:00.000Z -->\n\n## Context\n";
    expect(extractBaselineDone(body)).toBe(42);
  });
});

describe("extractProposedAt", () => {
  it("returns null when no marker is present", () => {
    expect(extractProposedAt("## Context\n\nnothing here\n")).toBeNull();
  });

  it("returns null for a legacy marker with no proposed-at field (back-compat)", () => {
    const body = "<!-- flow-stats-self-improve: baseline-done=42 -->\n\n## Context\n";
    expect(extractProposedAt(body)).toBeNull();
  });

  it("parses the marker's proposed-at timestamp as a Date", () => {
    const body = "<!-- flow-stats-self-improve: baseline-done=42 proposed-at=2026-08-07T00:00:00.000Z -->\n\n## Context\n";
    expect(extractProposedAt(body)).toEqual(new Date("2026-08-07T00:00:00.000Z"));
  });
});
