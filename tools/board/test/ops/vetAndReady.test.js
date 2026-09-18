import { describe, it, expect, vi } from "vitest";
import {
  resolveConfig,
  fetchTasks,
  fetchPollerState,
  makeGitLogGrep,
  applyReady,
  runVetAndReady
} from "../../ops/vetAndReady.js";

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
    body: "## Acceptance\n\n- [ ] Does the thing\n",
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

    expect(result.exitCode).toBe(0);
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

    expect(result.exitCode).toBe(0);
    const patchCalls = deps.fetchImpl.mock.calls.filter(([, opts]) => opts?.method === "PATCH");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0][0]).toBe("http://127.0.0.1:4173/api/tasks/T-0001");
  });

  it("reports a degraded poller state when /api/poller 404s, and still completes the run", async () => {
    const deps = makeDeps({ pollerOk: false });
    const result = await runVetAndReady({ env: {}, argv: [], now: () => new Date(), ...deps });
    expect(result.exitCode).toBe(0);
    expect(result.poller.available).toBe(false);
    expect(result.report).toMatch(/unavailable/);
  });

  it("exits 1 and never writes a summary if the board API itself is unreachable", async () => {
    const deps = makeDeps();
    deps.fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await runVetAndReady({ env: {}, argv: [], now: () => new Date(), ...deps });
    expect(result.exitCode).toBe(1);
    expect(deps.writeFileFn).not.toHaveBeenCalled();
  });
});
