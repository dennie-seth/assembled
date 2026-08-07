import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

// A real, valid 1x1 transparent PNG (magic bytes matter -- the endpoint sniffs content, not extension).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const SVG_WITH_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "utf8"
);

let repoRoot;
let tasksDir;
let server;
let baseUrl;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-attachments-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);

  tasksDir = path.join(repoRoot, "tasks");
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, repoRoot, tasksDir, port: 0 });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  delete process.env.AUTO_COMMIT_CARDS_ON_CREATE;
  delete process.env.BOARD_ATTACHMENT_MAX_BYTES;
  // This file opens far more keep-alive connections per run than other httpApi test files, which
  // makes it likely at least one is still idle-pooled by undici's fetch when the suite tears
  // down -- plain server.close() waits for those to time out on their own (~multiple seconds)
  // instead of returning. Force them closed so cleanup is instant either way.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test task", phase: 1, ...overrides })
  });
  return res.json();
}

function pngUploadForm({ filename = "reference.png", uploadedBy } = {}) {
  const form = new FormData();
  form.append("file", new Blob([TINY_PNG], { type: "image/png" }), filename);
  if (uploadedBy) form.append("uploaded_by", uploadedBy);
  return form;
}

describe("POST /api/tasks/:id/attachments", () => {
  it("uploads a file, persists it to disk under tasks/attachments/<id>/, and records metadata", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm()
    });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]).toMatchObject({
      filename: "reference.png",
      size: TINY_PNG.length,
      mimetype: "image/png",
      uploaded_by: "Anonymous"
    });
    expect(typeof updated.attachments[0].uploaded_at).toBe("string");

    const onDisk = await fs.readFile(path.join(tasksDir, "attachments", task.id, "reference.png"));
    expect(onDisk.equals(TINY_PNG)).toBe(true);
  });

  it("uses the provided uploaded_by field instead of defaulting to Anonymous", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm({ uploadedBy: "Dennie" })
    });

    const updated = await res.json();
    expect(updated.attachments[0].uploaded_by).toBe("Dennie");
  });

  it("keeps distinct filenames as separate coexisting entries", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm({ filename: "first.png" })
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm({ filename: "second.png" })
    });

    const updated = await res.json();
    expect(updated.attachments.map((a) => a.filename)).toEqual(["first.png", "second.png"]);
  });

  it("replaces the metadata entry in place when the same filename is uploaded twice, instead of appending a duplicate", async () => {
    const task = await createTask();
    const bigBinary = Buffer.concat([TINY_PNG, Buffer.alloc(50, 7)]);

    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm({ filename: "reference.png", uploadedBy: "First" })
    });
    const firstTask = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    const firstUploadedAt = firstTask.attachments[0].uploaded_at;

    const secondForm = new FormData();
    secondForm.append("file", new Blob([bigBinary], { type: "image/png" }), "reference.png");
    secondForm.append("uploaded_by", "Second");
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: secondForm
    });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]).toMatchObject({
      filename: "reference.png",
      size: bigBinary.length,
      uploaded_by: "Second"
    });
    expect(updated.attachments[0].uploaded_at >= firstUploadedAt).toBe(true);

    const onDisk = await fs.readFile(path.join(tasksDir, "attachments", task.id, "reference.png"));
    expect(onDisk.equals(bigBinary)).toBe(true);
  });

  it("commits the replacement as a modification, not a duplicate add, when re-uploading the same filename", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });

    const secondForm = new FormData();
    secondForm.append("file", new Blob([Buffer.alloc(20, 9)], { type: "application/octet-stream" }), "reference.png");
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: secondForm });

    const { stdout: status } = await git(
      ["status", "--porcelain", "--", `tasks/${task.id}.md`, `tasks/attachments/${task.id}/reference.png`],
      repoRoot
    );
    expect(status.trim()).toBe("");
    const { stdout: log } = await git(["log", "--oneline", "--", `tasks/attachments/${task.id}/reference.png`], repoRoot);
    expect(log.trim().split("\n")).toHaveLength(2);
  });

  it("re-uploading the same filename remains downloadable and consistent via GET after the replace", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });

    const newBytes = Buffer.alloc(30, 5);
    const secondForm = new FormData();
    secondForm.append("file", new Blob([newBytes], { type: "application/octet-stream" }), "reference.png");
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: secondForm });

    const taskRes = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(taskRes.attachments).toHaveLength(1);

    const downloadRes = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`);
    expect(downloadRes.status).toBe(200);
    const bytes = Buffer.from(await downloadRes.arrayBuffer());
    expect(bytes.equals(newBytes)).toBe(true);
  });

  it("commits both the card file and the attachment file to git in one commit", async () => {
    const task = await createTask();

    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm()
    });

    const { stdout: status } = await git(
      ["status", "--porcelain", "--", `tasks/${task.id}.md`, `tasks/attachments/${task.id}/reference.png`],
      repoRoot
    );
    expect(status.trim()).toBe("");
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toContain(task.id);
    expect(log.trim()).toContain("reference.png");
    const { stdout: lsFiles } = await git(
      ["ls-files", `tasks/${task.id}.md`, `tasks/attachments/${task.id}/reference.png`],
      repoRoot
    );
    expect(lsFiles.trim().split("\n").sort()).toEqual(
      [`tasks/${task.id}.md`, `tasks/attachments/${task.id}/reference.png`].sort()
    );
  });

  it("does not commit when AUTO_COMMIT_CARDS_ON_CREATE is disabled", async () => {
    const task = await createTask();
    process.env.AUTO_COMMIT_CARDS_ON_CREATE = "false";

    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm()
    });

    const { stdout: status } = await git(
      ["status", "--porcelain", "--", `tasks/${task.id}.md`, `tasks/attachments/${task.id}/`],
      repoRoot
    );
    expect(status).toContain(`M tasks/${task.id}.md`);
    expect(status).toContain(`?? tasks/attachments/${task.id}/`);
  });

  it("rejects SVG content sniffed as markup, even with an image/png declared type", async () => {
    const task = await createTask();
    const form = new FormData();
    form.append("file", new Blob([SVG_WITH_SCRIPT], { type: "image/png" }), "evil.png");

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });

    expect(res.status).toBe(415);
    const updated = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(updated.attachments).toEqual([]);
    await expect(
      fs.access(path.join(tasksDir, "attachments", task.id, "evil.png"))
    ).rejects.toThrow();
  });

  it("rejects HTML content", async () => {
    const task = await createTask();
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from("<!doctype html><html><body>hi</body></html>")], { type: "text/plain" }),
      "page.txt"
    );

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });
    expect(res.status).toBe(415);
  });

  it("allows arbitrary binary data that file-type can't sniff (e.g. a LoRA weights blob)", async () => {
    const task = await createTask();
    const opaqueBinary = Buffer.from([0x00, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef, 0x03, 0x04]);
    const form = new FormData();
    form.append("file", new Blob([opaqueBinary], { type: "application/octet-stream" }), "weights.safetensors");

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.attachments[0]).toMatchObject({
      filename: "weights.safetensors",
      mimetype: "application/octet-stream"
    });
  });

  it("rejects an upload exceeding the configured size cap with 413", async () => {
    process.env.BOARD_ATTACHMENT_MAX_BYTES = "100";
    const task = await createTask();
    const big = Buffer.alloc(200, 1);
    const form = new FormData();
    form.append("file", new Blob([big], { type: "application/octet-stream" }), "big.bin");

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });

    expect(res.status).toBe(413);
  });

  it("returns 400 when the request has no file part", async () => {
    const task = await createTask();
    const form = new FormData();
    form.append("uploaded_by", "Dennie");

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("returns 400 when Content-Type is not multipart/form-data", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "not multipart" })
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a task that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/attachments`, {
      method: "POST",
      body: pngUploadForm()
    });
    expect(res.status).toBe(404);
  });

  it("sanitizes a filename containing path segments to just its basename", async () => {
    const task = await createTask();
    const form = new FormData();
    form.append("file", new Blob([TINY_PNG], { type: "image/png" }), "../../etc/evil.png");

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.attachments[0].filename).toBe("evil.png");
    const entries = await fs.readdir(path.join(tasksDir, "attachments", task.id));
    expect(entries).toEqual(["evil.png"]);
  });

  it("rejects a bare '..' as the filename outright (400)", async () => {
    // Unlike a URL path segment, a multipart filename is raw header text -- not subject to the
    // URL parser's dot-segment normalization -- so an attacker really can send exactly "..".
    const task = await createTask();
    const form = new FormData();
    form.append("file", new Blob([TINY_PNG], { type: "image/png" }), "..");

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("returns 405 for GET on the attachments collection endpoint", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("still returns 201 with the updated task even if committing fails", async () => {
    const task = await createTask();
    await fs.rename(path.join(repoRoot, ".git"), path.join(repoRoot, ".git.disabled"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm()
    });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.attachments[0].filename).toBe("reference.png");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    await fs.rename(path.join(repoRoot, ".git.disabled"), path.join(repoRoot, ".git"));
  });

  it("works from curl -F (the way a programmatic task attaches files), not just fetch/FormData", async () => {
    const task = await createTask();
    const tmpFile = path.join(repoRoot, "curl-upload.png");
    await fs.writeFile(tmpFile, TINY_PNG);

    await execFileAsync("curl", [
      "-sS",
      "-f",
      "-X",
      "POST",
      `${baseUrl}/api/tasks/${task.id}/attachments`,
      "-F",
      `file=@${tmpFile};filename=curl.png;type=image/png`,
      "-F",
      "uploaded_by=curl-task"
    ]);

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    const updated = await res.json();
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]).toMatchObject({
      filename: "curl.png",
      mimetype: "image/png",
      uploaded_by: "curl-task"
    });
  });
});

describe("GET /api/tasks/:id/attachments/:filename", () => {
  async function uploadAndGetTask(filename = "reference.png") {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm({ filename })
    });
    return res.json();
  }

  it("streams the exact bytes back with the correct Content-Type and nosniff header", async () => {
    const task = await uploadAndGetTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(TINY_PNG)).toBe(true);
  });

  it("sets an inline disposition with an RFC-5987-encoded filename for previewable images", async () => {
    const task = await uploadAndGetTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`);
    const disposition = res.headers.get("content-disposition");

    expect(disposition).toContain("inline;");
    expect(disposition).toContain('filename="reference.png"');
    expect(disposition).toContain("filename*=UTF-8''reference.png");
  });

  it("sets an attachment disposition for non-image files", async () => {
    const task = await createTask();
    const opaqueBinary = Buffer.from([0x00, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef]);
    const form = new FormData();
    form.append("file", new Blob([opaqueBinary], { type: "application/octet-stream" }), "weights.bin");
    const uploadRes = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });
    const updated = await uploadRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${updated.id}/attachments/weights.bin`);
    expect(res.headers.get("content-disposition")).toContain("attachment;");
  });

  it("RFC-5987-encodes a filename with non-ASCII characters", async () => {
    const task = await uploadAndGetTask("réference.png");

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/${encodeURIComponent("réference.png")}`);
    const disposition = res.headers.get("content-disposition");

    expect(res.status).toBe(200);
    expect(disposition).toContain("filename*=UTF-8''r%C3%A9ference.png");
  });

  it("returns 404 for an attachment filename that was never uploaded", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/nope.png`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a task that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/attachments/nope.png`);
    expect(res.status).toBe(404);
  });

  it("is path-traversal-safe: an encoded ../ segment cannot escape the card's attachment dir", async () => {
    const task = await uploadAndGetTask();
    // README.md exists at repoRoot; if traversal worked this would leak it.
    const res = await fetch(
      `${baseUrl}/api/tasks/${task.id}/attachments/${encodeURIComponent("../../../README.md")}`
    );
    expect(res.status).toBe(404);
  });

});

describe("DELETE /api/tasks/:id/attachments/:filename", () => {
  it("removes the file from disk and the metadata entry, and returns the updated task", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`, { method: "DELETE" });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.attachments).toEqual([]);
    await expect(
      fs.access(path.join(tasksDir, "attachments", task.id, "reference.png"))
    ).rejects.toThrow();
  });

  it("commits the removal (git rm) alongside the card update", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });

    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`, { method: "DELETE" });

    const { stdout: status } = await git(
      ["status", "--porcelain", "--", `tasks/${task.id}.md`, `tasks/attachments/${task.id}/reference.png`],
      repoRoot
    );
    expect(status.trim()).toBe("");
    const { stdout: lsFiles } = await git(
      ["ls-files", `tasks/attachments/${task.id}/reference.png`],
      repoRoot
    );
    expect(lsFiles.trim()).toBe("");
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toContain("remove");
    expect(log.trim()).toContain("reference.png");
  });

  it("leaves other attachments untouched", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm({ filename: "keep.png" })
    });
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
      method: "POST",
      body: pngUploadForm({ filename: "remove.png" })
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/remove.png`, { method: "DELETE" });

    const updated = await res.json();
    expect(updated.attachments.map((a) => a.filename)).toEqual(["keep.png"]);
  });

  it("returns 404 for an attachment that does not exist", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/nope.png`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a task that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/attachments/nope.png`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 405 for PATCH on an attachment file endpoint", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`, { method: "PATCH" });
    expect(res.status).toBe(405);
  });
});

describe("DELETE /api/tasks/:id (attachment cleanup)", () => {
  it("also removes the card's attachment directory from <tasksDir>/attachments/<id>/ (T-0150)", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });
    const cardAttachmentsDir = path.join(tasksDir, "attachments", task.id);
    await expect(fs.stat(cardAttachmentsDir)).resolves.toBeTruthy();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    await expect(fs.stat(cardAttachmentsDir)).rejects.toThrow();
  });

  it("deleting a card with no attachments is a no-op on disk, not an error", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
  });

  it("does not delete another card's attachment directory when the deleted id is a prefix of it", async () => {
    const task = await createTask();
    const otherId = `${task.id}-evil`;
    await fs.mkdir(path.join(tasksDir, "attachments", otherId), { recursive: true });
    await fs.writeFile(path.join(tasksDir, "attachments", otherId, "keep.txt"), "keep me");

    await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });

    await expect(
      fs.readFile(path.join(tasksDir, "attachments", otherId, "keep.txt"), "utf8")
    ).resolves.toBe("keep me");
  });
});
