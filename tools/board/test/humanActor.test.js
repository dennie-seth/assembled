import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";
import {
  DEFAULT_HUMAN_ACTOR,
  humanActorFromEnv,
  isAgentActor,
  resolveAuthor
} from "../src/lib/approvalGate.js";

/**
 * Who a human action is recorded as.
 *
 * The approval gate (#288) records `approved_by` so a card says *who* signed off on its
 * direction. It shipped recording "Anonymous" for a comment approval (the UI sends no author,
 * and the comments endpoint defaulted to that) and "board-ui" for a drag to Done — neither of
 * which is a person, which defeats the point of recording it at all. The board is
 * single-user and unauthenticated, so there is no identity to derive; it is configured, via
 * `BOARD_HUMAN_ACTOR`.
 *
 * The security property this must not weaken: naming the operator creates an identity worth
 * impersonating, so the agent carve-out has to hold *harder* than before, not the same.
 */

let tasksDir;
let server;
let baseUrl;

const HUMAN = { "Content-Type": "application/json", "X-Board-Actor": "board-ui" };
const AGENT = { "Content-Type": "application/json", "X-Board-Actor": "agent" };

async function startServer(overrides = {}) {
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, tasksDir, port: 0, ...overrides });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return store;
}

beforeEach(async () => {
  delete process.env.BOARD_HUMAN_ACTOR;
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-humanactor-"));
});

afterEach(async () => {
  delete process.env.BOARD_HUMAN_ACTOR;
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await fs.rm(tasksDir, { recursive: true, force: true });
});

function createTask(overrides = {}) {
  return fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: HUMAN,
    body: JSON.stringify({ title: "Direction card", phase: 1, ...overrides })
  }).then((r) => r.json());
}

function patch(id, body, headers = HUMAN) {
  return fetch(`${baseUrl}/api/tasks/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
}

function comment(id, body, headers = HUMAN) {
  return fetch(`${baseUrl}/api/tasks/${id}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

describe("humanActorFromEnv", () => {
  it("defaults to the handle the repo already attributes Dennie by", () => {
    expect(DEFAULT_HUMAN_ACTOR).toBe("@DennieSeth");
    expect(humanActorFromEnv()).toBe("@DennieSeth");
  });

  it("is overridable via BOARD_HUMAN_ACTOR", () => {
    process.env.BOARD_HUMAN_ACTOR = "@someone-else";
    expect(humanActorFromEnv()).toBe("@someone-else");
  });

  it("falls back to the default for a blank or whitespace-only value", () => {
    process.env.BOARD_HUMAN_ACTOR = "   ";
    expect(humanActorFromEnv()).toBe(DEFAULT_HUMAN_ACTOR);
    process.env.BOARD_HUMAN_ACTOR = "";
    expect(humanActorFromEnv()).toBe(DEFAULT_HUMAN_ACTOR);
  });

  it("refuses a configured value that collides with a reserved agent identity", () => {
    // Otherwise `BOARD_HUMAN_ACTOR=reviewer` would silently make every agent-authored
    // comment look human to the gate -- a misconfiguration that disables the carve-out.
    for (const bad of ["agent", "reviewer", "assembled-board", "assets", "AGENT"]) {
      process.env.BOARD_HUMAN_ACTOR = bad;
      expect(humanActorFromEnv(), bad).toBe(DEFAULT_HUMAN_ACTOR);
    }
  });

  it("names an identity the gate reads as human", () => {
    expect(isAgentActor(DEFAULT_HUMAN_ACTOR)).toBe(false);
  });
});

describe("resolveAuthor", () => {
  it("uses an explicitly supplied author verbatim", () => {
    expect(resolveAuthor({ author: "Someone Else", actor: "board-ui" })).toBe("Someone Else");
  });

  it("falls back to the configured operator for a UI-originated action", () => {
    expect(resolveAuthor({ author: undefined, actor: "board-ui" })).toBe(DEFAULT_HUMAN_ACTOR);
    expect(resolveAuthor({ author: "   ", actor: "board-ui" })).toBe(DEFAULT_HUMAN_ACTOR);
  });

  it("never falls back to the human identity for an agent-originated action", () => {
    const resolved = resolveAuthor({ author: undefined, actor: "agent" });
    expect(resolved).not.toBe(DEFAULT_HUMAN_ACTOR);
    expect(isAgentActor(resolved)).toBe(true);
  });
});

describe("a UI approval records the configured operator, not Anonymous", () => {
  it("stamps approved_by on a comment approval", async () => {
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    // Exactly what the board UI sends: text only, no author field.
    const updated = await (await comment(task.id, { text: "APPROVED" })).json();

    expect(updated.status).toBe("done");
    expect(updated.approved_by).toBe("@DennieSeth");
    expect(updated.approved_by).not.toBe("Anonymous");
  });

  it("attributes the approving comment itself to the operator", async () => {
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const updated = await (await comment(task.id, { text: "APPROVED" })).json();

    expect(updated.comments[0].author).toBe("@DennieSeth");
    expect(updated.comments[1].text).toContain("@DennieSeth");
  });

  it("stamps approved_by on a drag to Done", async () => {
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const updated = await (await patch(task.id, { status: "done" })).json();

    expect(updated.status).toBe("done");
    expect(updated.approved_by).toBe("@DennieSeth");
    expect(updated.approved_by).not.toBe("board-ui");
  });

  it("honours BOARD_HUMAN_ACTOR end to end", async () => {
    process.env.BOARD_HUMAN_ACTOR = "@operator";
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    expect((await (await patch(task.id, { status: "done" })).json()).approved_by).toBe("@operator");
  });

  it("attributes an ordinary UI comment to the operator too", async () => {
    await startServer();
    const task = await createTask();

    const updated = await (await comment(task.id, { text: "CI failed on lint, please fix" })).json();

    expect(updated.comments[0].author).toBe("@DennieSeth");
  });

  it("still honours an explicitly supplied author", async () => {
    await startServer();
    const task = await createTask();

    const updated = await (await comment(task.id, { author: "Someone Else", text: "hi" })).json();

    expect(updated.comments[0].author).toBe("Someone Else");
  });
});

describe("an agent can never wear the operator's identity", () => {
  it("still refuses an agent-stamped PATCH to done, recording nothing", async () => {
    const store = await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await patch(task.id, { status: "done" }, AGENT);

    expect(res.status).toBe(409);
    const stored = await store.get(task.id);
    expect(stored.status).toBe("review");
    expect(stored.approved_by).toBe(null);
  });

  it("leaves an agent-stamped APPROVED comment inert, and does not author it as the operator", async () => {
    const store = await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const updated = await (await comment(task.id, { text: "APPROVED" }, AGENT)).json();

    expect(updated.status).toBe("review");
    expect(updated.approved_by).toBe(null);
    // The comment is recorded (refusing to approve is not refusing to speak) but must not
    // be filed under the human's name.
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0].author).not.toBe("@DennieSeth");
    expect(isAgentActor(updated.comments[0].author)).toBe(true);
    expect((await store.get(task.id)).approved_by).toBe(null);
  });

  it("refuses an agent-stamped comment that claims the operator's name as its author", async () => {
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const updated = await (
      await comment(task.id, { author: "@DennieSeth", text: "APPROVED" }, AGENT)
    ).json();

    expect(updated.status).toBe("review");
    expect(updated.approved_by).toBe(null);
  });

  it("refuses a request that smuggles a second actor value past the wrapper's stamp", async () => {
    // Empirically verified: Node joins duplicate X-Board-Actor headers into the single string
    // "agent, @DennieSeth". `agentCurl.js` always stamps `agent` first, but does not forbid a
    // caller's own `-H` (agents legitimately need it for ComfyUI), so an agent CAN append a
    // second value. Pre-fix, that joined string matched no reserved identity and was therefore
    // classified HUMAN -- the exact forgery this naming change would make worth attempting.
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await patch(
      task.id,
      { status: "done" },
      { "Content-Type": "application/json", "X-Board-Actor": "agent, @DennieSeth" }
    );

    expect(res.status).toBe(409);
  });

  it("treats a multi-valued actor header as an agent in isAgentActor itself", () => {
    expect(isAgentActor("agent, @DennieSeth")).toBe(true);
    expect(isAgentActor("@DennieSeth, agent")).toBe(true);
    expect(isAgentActor("board-ui, agent")).toBe(true);
    // A single ordinary human value is unaffected.
    expect(isAgentActor("@DennieSeth")).toBe(false);
    expect(isAgentActor("board-ui")).toBe(false);
  });

  it("does not let the runner stamp the operator either", async () => {
    // The orchestrator writes comments in-process under `assembled-board`; that identity must
    // stay an agent one no matter what BOARD_HUMAN_ACTOR says.
    process.env.BOARD_HUMAN_ACTOR = "@operator";
    expect(isAgentActor("assembled-board")).toBe(true);
    expect(resolveAuthor({ author: "assembled-board", actor: "agent" })).toBe("assembled-board");
  });
});

describe("attachment uploads", () => {
  it("attributes a UI upload to the operator instead of Anonymous", async () => {
    await startServer();
    const task = await createTask();

    const form = new FormData();
    form.append("file", new Blob([Buffer.from("hello")], { type: "text/plain" }), "note.txt");
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      headers: { "X-Board-Actor": "board-ui" },
      body: form
    });

    expect(res.status).toBe(201);
    expect((await res.json()).attachments[0].uploaded_by).toBe("@DennieSeth");
  });

  it("does not attribute an agent upload to the operator", async () => {
    await startServer();
    const task = await createTask();

    const form = new FormData();
    form.append("file", new Blob([Buffer.from("hello")], { type: "text/plain" }), "note.txt");
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      headers: { "X-Board-Actor": "agent" },
      body: form
    });

    expect(res.status).toBe(201);
    expect((await res.json()).attachments[0].uploaded_by).not.toBe("@DennieSeth");
  });
});

describe("regression: the #288 gate still behaves as it did", () => {
  it("does not approve a card that is not gated", async () => {
    await startServer();
    const task = await createTask({ status: "review" });

    const updated = await (await comment(task.id, { text: "APPROVED" })).json();

    expect(updated.status).toBe("review");
    expect(updated.approved_by).toBe(null);
  });

  it("does not approve on a comment that merely discusses approval", async () => {
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const updated = await (await comment(task.id, { text: "not approved yet" })).json();

    expect(updated.status).toBe("review");
    expect(updated.approved_by).toBe(null);
    expect(updated.comments[0].author).toBe("@DennieSeth");
  });

  it("still refuses any request that writes the approval record directly", async () => {
    await startServer();
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await patch(task.id, { approved_by: "@DennieSeth" });

    expect(res.status).toBe(400);
  });
});

describe("no stray Anonymous default remains in the request path", () => {
  it("has no literal Anonymous fallback left in httpApi.js", async () => {
    const src = await fs.readFile(new URL("../src/server/httpApi.js", import.meta.url), "utf8");
    // Comments stripped first: the word legitimately appears in the prose explaining what the
    // fallback used to be and why it changed. What must not survive is a *value*.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/"Anonymous"/);
  });

  it("keeps Anonymous readable as a human author on historical cards", () => {
    // 122 committed cards carry `author: "Anonymous"` comments from before this change.
    // They must keep working, and must not suddenly read as agent-authored.
    expect(isAgentActor("Anonymous")).toBe(false);
  });
});

describe("client sends its actor on the upload path too", () => {
  it("uploadAttachment stamps the board-ui actor", async () => {
    const { uploadAttachment } = await import("../src/client/api.js");
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });

    await uploadAttachment("T-0001", new Blob(["x"]), undefined);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/tasks/T-0001/attachments",
      expect.objectContaining({ headers: { "X-Board-Actor": "board-ui" } })
    );
    delete global.fetch;
  });
});
