import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../../src/lib/db/connection.js";
import { DbTaskStore } from "../../../src/lib/db/dbTaskStore.js";
import { readTaskBodyBeforeRun } from "../../../src/lib/db/dbTaskHistory.js";
import { makeTask } from "../../taskStoreContract.js";
import { PRE_REGISTRATION_HEADING } from "../../../src/lib/preRegisteredFinding.js";

let tmpDir;
let db;
let store;

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-dbtaskhistory-"));
  db = openDb(path.join(tmpDir, "board.db"));
  store = new DbTaskStore(db);
}

afterEach(async () => {
  if (db) db.close();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
  db = undefined;
  store = undefined;
});

/**
 * T-0342: readTaskBodyBeforeRun is db-mode's equivalent of gitTaskHistory.js's
 * readTaskBodyAtMergeBase -- the "before this run" body snapshot checkDeliverable.js's
 * finding-with-evidence route is pinned to, reconstructed from card_events (dbTaskStore.js's
 * audit trail) since db-mode tasks have no git-committed body history at all.
 *
 * runOrchestrator.js's real status sequence is in-progress (run start) -> validation (right
 * before the reviewer runs, which is always the moment checkDeliverable.js is invoked) ->
 * {review, blocked, in-progress (retry)}. Every scenario below drives DbTaskStore through that
 * exact sequence rather than hand-crafting card_events rows, so the test fails if the real
 * orchestrator's update() calls ever stop producing events shaped the way this function assumes.
 */
describe("readTaskBodyBeforeRun", () => {
  it("returns the body as it stood at the start of the run (the last in-progress transition before this validation)", async () => {
    await setup();
    const preRegisteredBody = `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`;
    await store.create(makeTask({ id: "T-9101", status: "ready", body: preRegisteredBody }));
    await store.update("T-9101", { status: "in-progress" });
    // Implementer runs the experiment and records a decisive finding during this run.
    await store.update("T-9101", { body: preRegisteredBody + "\n## Finding\ndecisive.\n" });
    await store.update("T-9101", { status: "validation" });

    const beforeBody = readTaskBodyBeforeRun(db, "T-9101");
    expect(beforeBody).toContain(PRE_REGISTRATION_HEADING);
    expect(beforeBody).not.toContain("## Finding");
  });

  it("does NOT see a pre-registration section added only after the run started (anti-retroactive guarantee)", async () => {
    await setup();
    await store.create(makeTask({ id: "T-9102", status: "ready", body: "## Context\nnothing yet\n" }));
    await store.update("T-9102", { status: "in-progress" });
    // The implementer adds pre-registration AND a decisive finding in the same run.
    await store.update("T-9102", {
      body: `${PRE_REGISTRATION_HEADING}\nadded retroactively\n\n## Finding\ndecisive, see \`evidence.png\`\n`
    });
    await store.update("T-9102", { status: "validation" });

    const beforeBody = readTaskBodyBeforeRun(db, "T-9102");
    expect(beforeBody).not.toContain(PRE_REGISTRATION_HEADING);
  });

  it("scopes to the current (latest) attempt only -- a retry's own start is the boundary, not an earlier attempt's", async () => {
    await setup();
    const preRegisteredBody = `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`;
    await store.create(makeTask({ id: "T-9103", status: "ready", body: preRegisteredBody }));
    await store.update("T-9103", { status: "in-progress" });
    await store.update("T-9103", { status: "validation" });
    // First attempt FAILed with no finding; orchestrator sends it back to in-progress for a retry.
    await store.update("T-9103", { status: "in-progress", body: preRegisteredBody + "\n## Validation: FAIL\nno finding recorded.\n" });
    // Second attempt records the finding and reaches validation again.
    await store.update("T-9103", {
      body: preRegisteredBody + "\n## Validation: FAIL\nno finding recorded.\n\n## Finding\ndecisive.\n"
    });
    await store.update("T-9103", { status: "validation" });

    const beforeBody = readTaskBodyBeforeRun(db, "T-9103");
    expect(beforeBody).toContain(PRE_REGISTRATION_HEADING);
    expect(beforeBody).toContain("Validation: FAIL");
    expect(beforeBody).not.toContain("## Finding");
  });

  it("returns an empty string when fewer than two status transitions exist (unknown run start -- safe default, never throws)", async () => {
    await setup();
    await store.create(makeTask({ id: "T-9104", status: "validation", body: `${PRE_REGISTRATION_HEADING}\nx\n` }));

    const beforeBody = readTaskBodyBeforeRun(db, "T-9104");
    expect(beforeBody).toBe("");
  });

  it("returns an empty string for a task with no card_events at all", async () => {
    await setup();
    const beforeBody = readTaskBodyBeforeRun(db, "T-NOPE");
    expect(beforeBody).toBe("");
  });
});
