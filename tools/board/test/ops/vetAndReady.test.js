import { describe, it, expect, vi } from "vitest";
import { execFile as callbackExec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "../helpers/rmTemp.js";
import {
  resolveConfig,
  fetchTasks,
  fetchPollerState,
  makeGitLogGrep,
  applyReady,
  findChangedVettedFields,
  runVetAndReady,
  EXIT_CODE_OK,
  EXIT_CODE_BOARD_UNREACHABLE,
  EXIT_CODE_WRITE_REFUSED
} from "../../ops/vetAndReady.js";
import { vetAndReady } from "../../src/lib/vetAndReady.js";
import { startHttpServer } from "../../src/server/httpApi.js";
import { DbTaskStore } from "../../src/lib/db/dbTaskStore.js";
import { IdAllocatorDb } from "../../src/lib/db/idAllocatorDb.js";

/**
 * T-0384: the WSL-native CLI wrapper. Every I/O boundary (board API, `git log`, filesystem) is
 * dependency-injected here so this suite never makes a real network call, spawns a real `git`
 * process, or touches a real file -- see runVetAndReady's parameters.
 */

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    status: "backlog",
    priority: "P1",
    phase: 7,
    agent: "infra",
    depends_on: [],
    deliverable_type: "code",
    requires_approval: false,
    // A checkable acceptance path so the default fixture clears rule 2 (mergedWorkCheck) on real
    // mechanical evidence -- see tools/board/test/lib/vetAndReady.test.js for the dedicated
    // prose-only-body coverage fix-round 2 (T-0384) adds.
    body: "## Acceptance\n\n- [ ] Update `src/lib/doTheThing.js` to do the thing.\n",
    ...overrides
  };
}

function jsonResponse(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return { ok, status, statusText, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("resolveConfig", () => {
  it("defaults to dry-run, port 4173, and a cap of 4", () => {
    const config = resolveConfig({}, []);
    expect(config.apply).toBe(false);
    expect(config.baseUrl).toBe("http://127.0.0.1:4173");
    expect(config.cap).toBe(4);
  });

  it("turns on apply mode only with the explicit --apply flag", () => {
    expect(resolveConfig({}, ["--apply"]).apply).toBe(true);
    expect(resolveConfig({}, ["--dry-run"]).apply).toBe(false);
  });

  it("honours BOARD_BASE_URL / BOARD_PORT / BOARD_VET_READY_CAP overrides", () => {
    const config = resolveConfig({ BOARD_PORT: "5000", BOARD_VET_READY_CAP: "2" }, []);
    expect(config.baseUrl).toBe("http://127.0.0.1:5000");
    expect(config.cap).toBe(2);
  });

  it("prefers an explicit BOARD_BASE_URL over BOARD_PORT", () => {
    const config = resolveConfig({ BOARD_BASE_URL: "http://127.0.0.1:9999", BOARD_PORT: "5000" }, []);
    expect(config.baseUrl).toBe("http://127.0.0.1:9999");
  });

  // Codex review 2026-09-18, finding 4: BOARD_VET_READY_CAP=10 let six clean candidates all
  // ready in one run. The per-run cap of 4 is a hard ceiling the config can lower but never
  // raise -- an oversized value clamps to 4, and the clamped (effective) value is what's reported.
  it("clamps an oversized BOARD_VET_READY_CAP down to the hard cap of 4", () => {
    const config = resolveConfig({ BOARD_VET_READY_CAP: "10" }, []);
    expect(config.cap).toBe(4);
  });

  it("still honours a smaller BOARD_VET_READY_CAP than 4", () => {
    expect(resolveConfig({ BOARD_VET_READY_CAP: "2" }, []).cap).toBe(2);
  });
});

describe("fetchTasks", () => {
  it("returns the parsed task list on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([makeTask()]));
    const tasks = await fetchTasks({ baseUrl: "http://127.0.0.1:4173", fetchImpl });
    expect(tasks).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4173/api/tasks");
  });

  it("throws with a clear message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, { ok: false, status: 500, statusText: "Internal Server Error" }));
    await expect(fetchTasks({ baseUrl: "http://127.0.0.1:4173", fetchImpl })).rejects.toThrow(/500/);
  });
});

describe("fetchPollerState", () => {
  it("reports the live poller state on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ enabled: true, intervalMs: 18000000, usageMax: 0.8 }));
    const poller = await fetchPollerState({ baseUrl: "http://127.0.0.1:4173", fetchImpl });
    expect(poller.available).toBe(true);
    expect(poller.enabled).toBe(true);
  });

  it("degrades gracefully to a documented fallback on a 404 (pre-T-0383 deployment)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, { ok: false, status: 404, statusText: "Not Found" }));
    const poller = await fetchPollerState({ baseUrl: "http://127.0.0.1:4173", fetchImpl });
    expect(poller.available).toBe(false);
    expect(poller.note).toMatch(/404/);
  });

  it("degrades gracefully, never throwing, when the request itself errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const poller = await fetchPollerState({ baseUrl: "http://127.0.0.1:4173", fetchImpl });
    expect(poller.available).toBe(false);
    expect(poller.note).toMatch(/ECONNREFUSED/);
  });
});

describe("makeGitLogGrep", () => {
  it("invokes git log on the configured base branch, scoped to the card id, and splits stdout into lines", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: "abc1234 feat: T-0042 done\ndef5678 fix: T-0042 followup\n", stderr: "" }));
    const gitLogGrep = makeGitLogGrep({ repoRoot: "/repo", baseBranch: "develop", execFileFn });
    const hits = await gitLogGrep("T-0042");
    expect(execFileFn).toHaveBeenCalledWith("git", ["-C", "/repo", "log", "develop", "--oneline", "-i", "--grep=T-0042"]);
    expect(hits).toEqual(["abc1234 feat: T-0042 done", "def5678 fix: T-0042 followup"]);
  });

  it("returns an empty list when git finds nothing", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const gitLogGrep = makeGitLogGrep({ repoRoot: "/repo", baseBranch: "develop", execFileFn });
    expect(await gitLogGrep("T-0042")).toEqual([]);
  });

  // Codex review 2026-09-18, finding 2: a card-id grep can never catch merged work that never
  // mentioned the card id. When the term looks like a path (has a file extension or a slash),
  // gitLogGrep now runs a path-scoped `git log -- <path>` instead of a message `--grep` -- pure
  // existence-on-the-base-branch checking, not content/prose interpretation.
  it("runs a path-scoped git log when the term looks like a file path, not a --grep", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: "abc1234 Implement feature flag\n", stderr: "" }));
    const gitLogGrep = makeGitLogGrep({ repoRoot: "/repo", baseBranch: "develop", execFileFn });
    const hits = await gitLogGrep("feature.js");
    expect(execFileFn).toHaveBeenCalledWith("git", ["-C", "/repo", "log", "develop", "--oneline", "--", "feature.js"]);
    expect(hits).toEqual(["abc1234 Implement feature flag"]);
  });

  it("still uses --grep for a card-id-shaped term with a slash-free, extension-free id", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const gitLogGrep = makeGitLogGrep({ repoRoot: "/repo", baseBranch: "develop", execFileFn });
    await gitLogGrep("T-0384");
    expect(execFileFn).toHaveBeenCalledWith("git", ["-C", "/repo", "log", "develop", "--oneline", "-i", "--grep=T-0384"]);
  });
});

describe("applyReady", () => {
  it("PATCHes status: ready with an agent actor header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeTask({ status: "ready" })));
    await applyReady({ baseUrl: "http://127.0.0.1:4173", id: "T-0001", fetchImpl });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4173/api/tasks/T-0001");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ status: "ready" });
    expect(opts.headers["X-Board-Actor"]).toMatch(/agent/);
  });

  it("throws with the status and id on failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, { ok: false, status: 409, statusText: "Conflict" }));
    await expect(applyReady({ baseUrl: "http://127.0.0.1:4173", id: "T-0001", fetchImpl })).rejects.toThrow(/409/);
  });

  // Codex review 2026-09-18, finding 3: the write must carry a server-enforced condition so a
  // stale write (the card changed between the check and the write) is refused, not silently
  // applied.
  //
  // T-0384 FIX ROUND 2 (Codex P2 #1, head d81d474c): a status-only condition is invisible to a
  // body/agent/deliverable_type/depends_on change that leaves status alone. `applyReady` now
  // takes the whole freshly-observed `expectedTask` and sends a fingerprint covering every vetted
  // field, never status in isolation.
  it("sends both X-Board-Expected-Status and a X-Board-Expected-Fields fingerprint when an expectedTask is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeTask({ status: "ready" })));
    const expectedTask = makeTask({ status: "backlog", agent: "infra", depends_on: ["T-0099"] });
    await applyReady({ baseUrl: "http://127.0.0.1:4173", id: "T-0001", fetchImpl, expectedTask });
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers["X-Board-Expected-Status"]).toBe("backlog");
    const fields = JSON.parse(opts.headers["X-Board-Expected-Fields"]);
    expect(fields.status).toBe("backlog");
    expect(fields.agent).toBe("infra");
    expect(fields.deliverable_type).toBe("code");
    expect(fields.requires_approval).toBe(false);
    expect(fields.depends_on).toEqual(["T-0099"]);
    expect(typeof fields.bodyHash).toBe("string");
    expect(fields.bodyHash.length).toBeGreaterThan(0);
    // bodyHash must actually reflect the body content, not a placeholder -- two different bodies
    // must hash differently.
    const otherFields = JSON.parse(
      (await (async () => {
        const otherFetch = vi.fn(async () => jsonResponse(makeTask({ status: "ready" })));
        await applyReady({
          baseUrl: "http://127.0.0.1:4173",
          id: "T-0001",
          fetchImpl: otherFetch,
          expectedTask: makeTask({ body: "## Held\nDo not ready.\n" })
        });
        return otherFetch.mock.calls[0][1].headers["X-Board-Expected-Fields"];
      })())
    );
    expect(otherFields.bodyHash).not.toBe(fields.bodyHash);
  });

  it("omits both expected headers entirely when no expectedTask is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeTask({ status: "ready" })));
    await applyReady({ baseUrl: "http://127.0.0.1:4173", id: "T-0001", fetchImpl });
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers["X-Board-Expected-Status"]).toBeUndefined();
    expect(opts.headers["X-Board-Expected-Fields"]).toBeUndefined();
  });

  // T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #2): a dependency re-check via a plain GET
  // before this PATCH is not atomic with the write. This job is the only caller of applyReady,
  // and readying a card whose dependency isn't done/retired is exactly what rule 1 forbids -- so
  // every write this job makes asks the atomic write itself to re-verify dependencies too.
  it("sends X-Board-Require-Dependencies-Satisfied whenever an expectedTask is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeTask({ status: "ready" })));
    await applyReady({ baseUrl: "http://127.0.0.1:4173", id: "T-0001", fetchImpl, expectedTask: makeTask() });
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers["X-Board-Require-Dependencies-Satisfied"]).toBe("true");
  });

  it("omits X-Board-Require-Dependencies-Satisfied when no expectedTask is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeTask({ status: "ready" })));
    await applyReady({ baseUrl: "http://127.0.0.1:4173", id: "T-0001", fetchImpl });
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers["X-Board-Require-Dependencies-Satisfied"]).toBeUndefined();
  });
});

/**
 * T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #1): `revalidateCandidate` alone re-checks the
 * FRESH snapshot against itself (still eligible? dependencies still met? no NEW superseding
 * marker?) -- it was never able to catch a vetted field quietly changing to a DIFFERENT, still
 * perfectly-innocent-looking value, because it has nothing to compare the fresh snapshot AGAINST.
 * `findChangedVettedFields` is that comparison: the ORIGINAL, selection-time snapshot against the
 * fresh one, reusing the exact same field set (and the same `body` naming) the server-side
 * `X-Board-Expected-Fields` fingerprint already checks.
 */
describe("findChangedVettedFields", () => {
  it("returns an empty list when nothing vetted has changed", () => {
    const original = makeTask();
    const fresh = makeTask();
    expect(findChangedVettedFields(original, fresh)).toEqual([]);
  });

  it("names 'body' when the acceptance/body changed, even with no governing marker present", () => {
    const original = makeTask({ body: "## Acceptance\n\n- [ ] Add `src/newFeature.js`.\n" });
    const fresh = makeTask({ body: "## Acceptance\n\n- [ ] Add `src/alreadyMerged.js`.\n" });
    expect(findChangedVettedFields(original, fresh)).toEqual(["body"]);
  });

  it("names every changed field, not just the first", () => {
    const original = makeTask({ agent: "infra", depends_on: [] });
    const fresh = makeTask({ agent: "server", depends_on: ["T-0099"] });
    expect(findChangedVettedFields(original, fresh)).toEqual(["agent", "depends_on"]);
  });
});

describe("runVetAndReady", () => {
  function makeDeps({ tasks = [makeTask()], pollerOk = false, execStdout = "" } = {}) {
    const fetchImpl = vi.fn(async (url, opts) => {
      if (url.endsWith("/api/tasks")) return jsonResponse(tasks);
      if (url.endsWith("/api/poller")) {
        return pollerOk
          ? jsonResponse({ enabled: true, intervalMs: 18000000, usageMax: 0.8 })
          : jsonResponse(null, { ok: false, status: 404, statusText: "Not Found" });
      }
      if (opts?.method === "PATCH") return jsonResponse(makeTask({ status: "ready" }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const execFileFn = vi.fn(async () => ({ stdout: execStdout, stderr: "" }));
    const writeFileFn = vi.fn(async () => {});
    const mkdirFn = vi.fn(async () => {});
    const appendFileFn = vi.fn(async () => {});
    const logFn = vi.fn();
    return { fetchImpl, execFileFn, writeFileFn, mkdirFn, appendFileFn, logFn };
  }

  it("dry run: fetches, decides, prints and writes the report, but never PATCHes", async () => {
    const deps = makeDeps({ tasks: [makeTask({ id: "T-0001" })] });
    const result = await runVetAndReady({
      env: {},
      argv: [],
      now: () => new Date("2026-09-18T01:00:00.000Z"),
      ...deps
    });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.result.readied.map((r) => r.id)).toEqual(["T-0001"]);
    const patchCalls = deps.fetchImpl.mock.calls.filter(([, opts]) => opts?.method === "PATCH");
    expect(patchCalls).toHaveLength(0);
    expect(deps.writeFileFn).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = deps.writeFileFn.mock.calls[0];
    expect(writtenPath).toMatch(/latest\.md$/);
    expect(writtenContent).toMatch(/Dry run/);
    expect(deps.logFn).toHaveBeenCalled();
  });

  it("apply mode: PATCHes status: ready only for the readied cards", async () => {
    const deps = makeDeps({
      tasks: [makeTask({ id: "T-0001" }), makeTask({ id: "T-0002", depends_on: ["T-0099"] })]
    });
    const result = await runVetAndReady({ env: {}, argv: ["--apply"], now: () => new Date("2026-09-18T01:00:00.000Z"), ...deps });

    // The one readied candidate writes cleanly -- no write-time refusal, so this stays OK.
    expect(result.exitCode).toBe(EXIT_CODE_OK);
    const patchCalls = deps.fetchImpl.mock.calls.filter(([, opts]) => opts?.method === "PATCH");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0][0]).toBe("http://127.0.0.1:4173/api/tasks/T-0001");
  });

  it("apply mode: sends the observed status AND a full field fingerprint on the write", async () => {
    const deps = makeDeps({ tasks: [makeTask({ id: "T-0001", status: "backlog" })] });
    await runVetAndReady({ env: {}, argv: ["--apply"], now: () => new Date("2026-09-18T01:00:00.000Z"), ...deps });
    const patchCalls = deps.fetchImpl.mock.calls.filter(([, opts]) => opts?.method === "PATCH");
    expect(patchCalls[0][1].headers["X-Board-Expected-Status"]).toBe("backlog");
    const fields = JSON.parse(patchCalls[0][1].headers["X-Board-Expected-Fields"]);
    expect(fields).toMatchObject({ status: "backlog", agent: "infra", deliverable_type: "code", requires_approval: false });
    expect(typeof fields.bodyHash).toBe("string");
  });

  // T-0384 FIX ROUND 2 (Codex P2 #1, head d81d474c): revalidation used to happen once, off one
  // fresh fetch shared by the whole apply loop -- a later candidate's revalidation was checked
  // against a snapshot that could already be stale by the time ITS write happened, especially
  // with an earlier candidate's write landing in between. Each candidate now gets its own fresh
  // `GET /api/tasks` immediately before its own write.
  it("apply mode: re-fetches the task list freshly for EACH candidate, not once for the whole batch", async () => {
    const deps = makeDeps({
      tasks: [makeTask({ id: "T-0001", priority: "P0" }), makeTask({ id: "T-0002", priority: "P1" })]
    });
    await runVetAndReady({ env: {}, argv: ["--apply"], now: () => new Date("2026-09-18T01:00:00.000Z"), ...deps });
    const taskListFetches = deps.fetchImpl.mock.calls.filter(([url]) => url.endsWith("/api/tasks"));
    // One fetch during selection, plus one PER readied candidate immediately before its own write.
    expect(taskListFetches.length).toBeGreaterThanOrEqual(3);
  });

  // A later candidate's vetted fields (not just status) change while an earlier candidate's write
  // is already in flight: the changed candidate must be skipped and reported, and the earlier
  // write must still go through untouched.
  it("apply mode: skips a later candidate whose body changed while an earlier candidate's write was in flight, without disturbing the earlier write", async () => {
    let t1 = makeTask({ id: "T-0001", priority: "P0" });
    let t2 = makeTask({ id: "T-0002", priority: "P1" });
    let t1PatchStarted = false;
    const fetchImpl = vi.fn(async (url, opts) => {
      if (url.endsWith("/api/tasks")) return jsonResponse([t1, t2]);
      if (url.endsWith("/api/poller")) return jsonResponse(null, { ok: false, status: 404, statusText: "Not Found" });
      if (opts?.method === "PATCH" && url.endsWith("/T-0001")) {
        t1PatchStarted = true;
        // While T-0001's write is in flight, a separate actor adds a Held marker to T-0002.
        t2 = { ...t2, body: "## Held\nDo not ready this card until a human decision.\n" };
        t1 = { ...t1, ...JSON.parse(opts.body) };
        return jsonResponse(t1);
      }
      if (opts?.method === "PATCH" && url.endsWith("/T-0002")) {
        throw new Error("T-0002 must never be PATCHed once it picks up a Held marker");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runVetAndReady({
      env: {},
      argv: ["--apply"],
      fetchImpl,
      execFileFn: vi.fn(async () => ({ stdout: "", stderr: "" })),
      writeFileFn: vi.fn(async () => {}),
      mkdirFn: vi.fn(async () => {}),
      appendFileFn: vi.fn(async () => {}),
      logFn: vi.fn(),
      now: () => new Date("2026-09-18T01:00:00.000Z")
    });

    expect(t1PatchStarted).toBe(true);
    expect(t1.status).toBe("ready");
    expect(t2.status).toBe("backlog");
    // T-0384 FIX ROUND 3: a write-time refusal (T-0002, caught by pre-write revalidation) must
    // surface as a distinct non-zero exit code even though T-0001's own write succeeded -- an
    // apply run is not "fully successful" just because at least one candidate got written.
    expect(result.exitCode).toBe(EXIT_CODE_WRITE_REFUSED);
    expect(result.report).toMatch(/T-0002/);
    expect(result.report).toMatch(/SKIPPED/);
  });

  // Codex review 2026-09-18, finding 3, reproduced against the real runVetAndReady wiring (not
  // just the probe): a card flips to "done" (simulating a concurrent human/agent write) during
  // the per-candidate git check that happens between selection and the apply loop. Apply mode
  // must re-fetch and revalidate immediately before the write and perform ZERO writes here.
  it("apply mode: performs zero writes and reports the card as changed when it flips status underneath the run (Codex's concurrent-status-change probe)", async () => {
    let current = makeTask({ id: "T-9001", status: "backlog" });
    const writes = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      if (url.endsWith("/api/tasks")) return jsonResponse([{ ...current }]);
      if (url.endsWith("/api/poller")) return jsonResponse(null, { ok: false, status: 404, statusText: "Not Found" });
      writes.push({ before: current.status, patch: JSON.parse(opts.body) });
      current = { ...current, ...JSON.parse(opts.body) };
      return jsonResponse(current);
    });
    // The mock's git-check side effect mimics a concurrent write landing on the card while the
    // run is still working through its own per-candidate checks -- same shape as Codex's probe.
    const execFileFn = vi.fn(async () => {
      current = { ...current, status: "done" };
      return { stdout: "", stderr: "" };
    });

    const result = await runVetAndReady({
      env: {},
      argv: ["--apply"],
      fetchImpl,
      execFileFn,
      writeFileFn: vi.fn(async () => {}),
      mkdirFn: vi.fn(async () => {}),
      appendFileFn: vi.fn(async () => {}),
      logFn: vi.fn(),
      now: () => new Date("2026-09-18T01:00:00.000Z")
    });

    expect(writes).toHaveLength(0);
    expect(current.status).toBe("done");
    // Every candidate here was refused at write time (there was only one, and it was refused) --
    // zero writes landed, so this must NOT read as a clean run.
    expect(result.exitCode).toBe(EXIT_CODE_WRITE_REFUSED);
    expect(result.report).toMatch(/T-9001/);
    expect(result.report).toMatch(/SKIPPED/);
  });

  it("reports a degraded poller state when /api/poller 404s, and still completes the run", async () => {
    const deps = makeDeps({ pollerOk: false });
    const result = await runVetAndReady({ env: {}, argv: [], now: () => new Date(), ...deps });
    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.poller.available).toBe(false);
    expect(result.report).toMatch(/unavailable/);
  });

  it("exits EXIT_CODE_BOARD_UNREACHABLE and never writes a summary if the board API itself is unreachable", async () => {
    const deps = makeDeps();
    deps.fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await runVetAndReady({ env: {}, argv: [], now: () => new Date(), ...deps });
    expect(result.exitCode).toBe(EXIT_CODE_BOARD_UNREACHABLE);
    expect(EXIT_CODE_BOARD_UNREACHABLE).not.toBe(EXIT_CODE_WRITE_REFUSED);
    expect(deps.writeFileFn).not.toHaveBeenCalled();
  });

  // T-0384 FIX ROUND 3: a dry run never writes anything, so it is never a "write-time refusal" --
  // even when every single candidate would have been skipped had this been an apply run, the dry
  // run itself must stay a green systemd unit.
  it("dry run always exits EXIT_CODE_OK, even when every candidate would be write-refused in apply mode", async () => {
    const deps = makeDeps({
      tasks: [makeTask({ id: "T-0001" }), makeTask({ id: "T-0002" })]
    });
    const result = await runVetAndReady({ env: {}, argv: [], now: () => new Date("2026-09-18T01:00:00.000Z"), ...deps });
    expect(result.exitCode).toBe(EXIT_CODE_OK);
  });

  // T-0384 FIX ROUND 3: an ordinary selection-time skip (here, an unmet dependency -- rule 1) is
  // decided before the apply loop even starts and never attempts a write, so it must never trip
  // the write-refused exit code, in dry run OR apply mode.
  it("a selection-time-only skip (unmet dependency) exits EXIT_CODE_OK in both dry run and apply mode", async () => {
    const tasks = [makeTask({ id: "T-0001", depends_on: ["T-0099"] })];
    const dryRun = makeDeps({ tasks });
    const dryResult = await runVetAndReady({ env: {}, argv: [], now: () => new Date("2026-09-18T01:00:00.000Z"), ...dryRun });
    expect(dryResult.result.readied).toEqual([]);
    expect(dryResult.exitCode).toBe(EXIT_CODE_OK);

    const applyRun = makeDeps({ tasks });
    const applyResult = await runVetAndReady({ env: {}, argv: ["--apply"], now: () => new Date("2026-09-18T01:00:00.000Z"), ...applyRun });
    expect(applyResult.result.readied).toEqual([]);
    expect(applyResult.exitCode).toBe(EXIT_CODE_OK);
    const patchCalls = applyRun.fetchImpl.mock.calls.filter(([, opts]) => opts?.method === "PATCH");
    expect(patchCalls).toHaveLength(0);
  });
});

/**
 * Codex review 2026-09-18, finding 2 -- reproduces Codex's own merged-work-probe.mjs against a
 * REAL temporary git repo (not a mocked gitLogGrep), so this is the actual makeGitLogGrep +
 * mergedWorkCheck wiring under test, end to end: develop already contains `feature.js` exporting
 * `featureEnabled = true`, committed as "Implement feature flag" -- no mention of the card id
 * anywhere. Before the fix this cleared (readied); after the fix it must skip.
 */
describe("mergedWorkCheck against a real git repo (Codex's merged-work-probe fixture)", () => {
  it("skips a card whose acceptance names a path that already has history on develop, even with zero card-id hits", async () => {
    const execFileFn = promisify(callbackExec);
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "board-vet-merged-work-"));
    try {
      const git = (...args) => execFileFn("git", ["-C", repoRoot, ...args]);
      await git("init", "-q", "-b", "develop");
      await writeFile(path.join(repoRoot, "feature.js"), "export const featureEnabled = true;\n");
      await git("add", "feature.js");
      await git(
        "-c",
        "user.name=Review Fixture",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "-qm",
        "Implement feature flag"
      );

      const task = {
        id: "T-9001",
        title: "Add feature flag",
        priority: "P1",
        status: "backlog",
        agent: "infra",
        deliverable_type: "code",
        requires_approval: false,
        depends_on: [],
        body: "## Acceptance\n- feature.js exports featureEnabled = true.\n"
      };
      const gitLogGrep = makeGitLogGrep({ repoRoot, baseBranch: "develop", execFileFn });
      const result = await vetAndReady({ tasks: [task], gitLogGrep });

      expect(result.readied).toEqual([]);
      const skipped = result.skipped.find((entry) => entry.id === "T-9001");
      expect(skipped).toBeTruthy();
      expect(skipped.rule).toBe("2-merged");
      expect(skipped.reason).toMatch(/feature\.js/);
    } finally {
      await rmTemp(repoRoot);
    }
  });
});

/**
 * T-0384 FIX ROUND 2 -- Codex follow-up review of #396 (head d81d474c), P2 #1: reproduces the
 * real reproduction Codex ran against `runVetAndReady`, a real isolated HTTP server, and a real
 * (in-memory) `DbTaskStore` -- not mocks. Before this fix, `applyReadiedCards` revalidated once
 * off a snapshot fetched before the apply loop and then wrote with an `X-Board-Expected-Status`
 * condition covering status alone, so a body change landing between that check and the PATCH
 * (even one recorded via the store's own `update`, the same path a human/another agent would use)
 * was invisible to the write. The card is now expected to stay `backlog` with the Held section
 * intact, and the run reports the skip -- zero writes ever land on a card that stopped being safe
 * to ready.
 */
describe("runVetAndReady against a real HTTP server + a real DbTaskStore (Codex's P2 #1 reproduction)", () => {
  function makeReadyCandidate(overrides = {}) {
    return {
      id: "T-9001",
      title: "Do the thing",
      status: "backlog",
      priority: "P1",
      phase: 7,
      agent: "infra",
      depends_on: [],
      deliverable_type: "code",
      requires_approval: false,
      created: "2026-09-18",
      body: "## Acceptance\n\n- [ ] Update `src/lib/doTheThing.js` to do the thing.\n",
      ...overrides
    };
  }

  async function setup() {
    const store = new DbTaskStore(":memory:");
    const idAllocator = new IdAllocatorDb(store.db);
    const server = await startHttpServer({ store, idAllocator, taskStoreKind: "db", port: 0 });
    const { port } = server.address();
    return {
      store,
      baseUrl: `http://127.0.0.1:${port}`,
      teardown: async () => {
        await new Promise((resolve) => server.close(resolve));
        store.close();
      }
    };
  }

  it("does not ready a card whose body gains a Held marker between client-side revalidation and the server-side write", async () => {
    const { store, baseUrl, teardown } = await setup();
    try {
      await store.create(makeReadyCandidate());

      let patchIntercepted = false;
      const fetchImpl = async (url, opts) => {
        if (opts?.method === "PATCH" && !patchIntercepted) {
          patchIntercepted = true;
          // Simulates a human/another agent writing the Held marker via the same store the HTTP
          // server itself uses, in the gap between this run's own pre-write revalidation (already
          // done by the time applyReady is called) and the PATCH actually reaching the server.
          await store.update("T-9001", {
            body: "## Held\nDo not ready this card until a human decision.\n"
          });
        }
        return fetch(url, opts);
      };

      const result = await runVetAndReady({
        env: { BOARD_BASE_URL: baseUrl },
        argv: ["--apply"],
        fetchImpl,
        execFileFn: async () => ({ stdout: "", stderr: "" }),
        writeFileFn: async () => {},
        mkdirFn: async () => {},
        appendFileFn: async () => {},
        logFn: () => {},
        now: () => new Date("2026-09-18T01:00:00.000Z")
      });

      expect(patchIntercepted).toBe(true);
      const final = await store.get("T-9001");
      expect(final.status).toBe("backlog");
      expect(final.body).toMatch(/Held/);
      // The only candidate in this run was refused at write time (the server-enforced fingerprint
      // condition rejected the stale PATCH) -- a real apply run against a real store must not
      // report this as a clean, fully-successful run.
      expect(result.exitCode).toBe(EXIT_CODE_WRITE_REFUSED);
      expect(result.report).toMatch(/T-9001/);
      expect(result.report).toMatch(/SKIPPED/);
    } finally {
      await teardown();
    }
  });

  it("skips a later candidate that changes while an earlier candidate's PATCH is in flight, and still completes the earlier write", async () => {
    const { store, baseUrl, teardown } = await setup();
    try {
      await store.create(makeReadyCandidate({ id: "T-9001", priority: "P0" }));
      await store.create(
        makeReadyCandidate({
          id: "T-9002",
          priority: "P1",
          body: "## Acceptance\n\n- [ ] Update `src/lib/doOtherThing.js` to do the other thing.\n"
        })
      );

      let firstPatchSeen = false;
      const fetchImpl = async (url, opts) => {
        if (opts?.method === "PATCH" && url.endsWith("/T-9001") && !firstPatchSeen) {
          firstPatchSeen = true;
          await store.update("T-9002", { body: "## Held\nDo not ready this card.\n" });
        }
        return fetch(url, opts);
      };

      const result = await runVetAndReady({
        env: { BOARD_BASE_URL: baseUrl },
        argv: ["--apply"],
        fetchImpl,
        execFileFn: async () => ({ stdout: "", stderr: "" }),
        writeFileFn: async () => {},
        mkdirFn: async () => {},
        appendFileFn: async () => {},
        logFn: () => {},
        now: () => new Date("2026-09-18T01:00:00.000Z")
      });

      const t1 = await store.get("T-9001");
      const t2 = await store.get("T-9002");
      expect(t1.status).toBe("ready");
      expect(t2.status).toBe("backlog");
      expect(result.report).toMatch(/T-9002/);
      expect(result.report).toMatch(/SKIPPED/);
      // T-0001's write succeeded, but T-9002 was refused at write time -- the run is not "fully
      // successful" and must not exit identically to a run where every candidate wrote cleanly.
      expect(result.exitCode).toBe(EXIT_CODE_WRITE_REFUSED);
    } finally {
      await teardown();
    }
  });

  // T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #1): before this round, `applyReadiedCards`
  // only ever compared the FRESH per-candidate snapshot against itself (`revalidateCandidate`) --
  // it never compared it against what selection actually vetted. A body/acceptance change to a
  // DIFFERENT but still perfectly innocent-looking value (no Held marker, still eligible, deps
  // still fine) sailed straight through both the client-side re-check AND the server-side write,
  // because the write's own `X-Board-Expected-Fields` condition was built from the FRESH snapshot
  // too -- which, by definition, always matches itself. This reproduces Codex's fixture: the
  // acceptance is rewritten from an unmerged path to an already-merged one, with no governing
  // marker, in the gap between selection and this run's own per-candidate re-fetch.
  it("does not ready a card whose acceptance changes to a different (unmarked, still-eligible) value between selection and its own pre-write re-fetch", async () => {
    const { store, baseUrl, teardown } = await setup();
    try {
      await store.create(makeReadyCandidate({ body: "## Acceptance\n\n- [ ] Add `src/newFeature.js`.\n" }));

      let taskListFetchCount = 0;
      const fetchImpl = async (url, opts) => {
        if (url.endsWith("/api/tasks") && !opts) {
          taskListFetchCount += 1;
          if (taskListFetchCount === 2) {
            // The card's acceptance is rewritten -- no Held/superseded marker anywhere -- in the
            // gap between this run's selection GET (#1) and its own per-candidate re-fetch (#2).
            await store.update("T-9001", {
              body: "## Acceptance\n\n- [ ] Add `src/alreadyMerged.js`.\n"
            });
          }
        }
        return fetch(url, opts);
      };

      const result = await runVetAndReady({
        env: { BOARD_BASE_URL: baseUrl },
        argv: ["--apply"],
        fetchImpl,
        execFileFn: async () => ({ stdout: "", stderr: "" }),
        writeFileFn: async () => {},
        mkdirFn: async () => {},
        appendFileFn: async () => {},
        logFn: () => {},
        now: () => new Date("2026-09-19T01:00:00.000Z")
      });

      const final = await store.get("T-9001");
      expect(final.status).toBe("backlog");
      expect(final.body).toMatch(/alreadyMerged/);
      expect(result.exitCode).toBe(EXIT_CODE_WRITE_REFUSED);
      expect(result.report).toMatch(/T-9001/);
      expect(result.report).toMatch(/body/);
    } finally {
      await teardown();
    }
  });

  it("skips a later candidate whose acceptance changes (no marker) while an earlier candidate's write is in flight, and still completes the earlier write", async () => {
    const { store, baseUrl, teardown } = await setup();
    try {
      await store.create(makeReadyCandidate({ id: "T-9001", priority: "P0" }));
      await store.create(
        makeReadyCandidate({
          id: "T-9002",
          priority: "P1",
          body: "## Acceptance\n\n- [ ] Add `src/newFeature.js`.\n"
        })
      );

      let firstPatchSeen = false;
      const fetchImpl = async (url, opts) => {
        if (opts?.method === "PATCH" && url.endsWith("/T-9001") && !firstPatchSeen) {
          firstPatchSeen = true;
          // No Held marker -- just a different, still-innocent-looking acceptance section.
          await store.update("T-9002", { body: "## Acceptance\n\n- [ ] Add `src/alreadyMerged.js`.\n" });
        }
        return fetch(url, opts);
      };

      const result = await runVetAndReady({
        env: { BOARD_BASE_URL: baseUrl },
        argv: ["--apply"],
        fetchImpl,
        execFileFn: async () => ({ stdout: "", stderr: "" }),
        writeFileFn: async () => {},
        mkdirFn: async () => {},
        appendFileFn: async () => {},
        logFn: () => {},
        now: () => new Date("2026-09-19T01:00:00.000Z")
      });

      const t1 = await store.get("T-9001");
      const t2 = await store.get("T-9002");
      expect(t1.status).toBe("ready");
      expect(t2.status).toBe("backlog");
      expect(t2.body).toMatch(/alreadyMerged/);
      expect(result.report).toMatch(/T-9002/);
      expect(result.report).toMatch(/SKIPPED/);
      expect(result.exitCode).toBe(EXIT_CODE_WRITE_REFUSED);
    } finally {
      await teardown();
    }
  });

  // T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #2): the launch guard is a later defence, but
  // readying an ineligible card in the first place breaks this job's own rule 1 and burns a ready
  // slot. Dependency status has to be re-checked INSIDE the atomic write, because a plain GET
  // beforehand (this run's own per-candidate re-fetch, which already passed) leaves exactly the
  // same TOCTOU gap as every other field this round closes.
  it("does not ready a card whose dependency regresses out of done/retired between the pre-write re-fetch and the PATCH landing", async () => {
    const { store, baseUrl, teardown } = await setup();
    try {
      await store.create(makeReadyCandidate({ id: "T-9002", status: "done", depends_on: [] }));
      await store.create(makeReadyCandidate({ id: "T-9001", depends_on: ["T-9002"] }));

      let patchIntercepted = false;
      const fetchImpl = async (url, opts) => {
        if (opts?.method === "PATCH" && !patchIntercepted) {
          patchIntercepted = true;
          // The dependency regresses in the gap between this run's own pre-write re-fetch (which
          // still saw it as done) and the PATCH actually reaching the server.
          await store.update("T-9002", { status: "backlog" });
        }
        return fetch(url, opts);
      };

      const result = await runVetAndReady({
        env: { BOARD_BASE_URL: baseUrl },
        argv: ["--apply"],
        fetchImpl,
        execFileFn: async () => ({ stdout: "", stderr: "" }),
        writeFileFn: async () => {},
        mkdirFn: async () => {},
        appendFileFn: async () => {},
        logFn: () => {},
        now: () => new Date("2026-09-19T01:00:00.000Z")
      });

      expect(patchIntercepted).toBe(true);
      const final = await store.get("T-9001");
      expect(final.status).toBe("backlog");
      expect(result.exitCode).toBe(EXIT_CODE_WRITE_REFUSED);
      expect(result.report).toMatch(/T-9001/);
      expect(result.report).toMatch(/T-9002/);
    } finally {
      await teardown();
    }
  });

  it("readies a card whose dependency is still done/retired at write time (complement)", async () => {
    const { store, baseUrl, teardown } = await setup();
    try {
      await store.create(makeReadyCandidate({ id: "T-9002", status: "done", depends_on: [] }));
      await store.create(makeReadyCandidate({ id: "T-9001", depends_on: ["T-9002"] }));

      const result = await runVetAndReady({
        env: { BOARD_BASE_URL: baseUrl },
        argv: ["--apply"],
        fetchImpl: fetch,
        execFileFn: async () => ({ stdout: "", stderr: "" }),
        writeFileFn: async () => {},
        mkdirFn: async () => {},
        appendFileFn: async () => {},
        logFn: () => {},
        now: () => new Date("2026-09-19T01:00:00.000Z")
      });

      const final = await store.get("T-9001");
      expect(final.status).toBe("ready");
      expect(result.exitCode).toBe(EXIT_CODE_OK);
    } finally {
      await teardown();
    }
  });
});
