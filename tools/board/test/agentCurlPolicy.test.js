import { describe, it, expect } from "vitest";
import { checkAgentCurlRequest } from "../src/lib/agentCurlPolicy.js";

const BOARD = "http://127.0.0.1:4173";
const VITE = "http://127.0.0.1:5173";
const COMFY = "http://172.18.192.1:8188";

describe("agentCurlPolicy -- board API is read-only to agents", () => {
  it("denies the exact self-status PATCH that T-0221 used to route around a denied gh pr create", () => {
    const verdict = checkAgentCurlRequest({
      method: "PATCH",
      url: `${BOARD}/api/tasks/T-0153`,
      args: ["-s", "-H", "Content-Type: application/json", "-d", '{"status":"review"}']
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/board API/);
  });

  it.each([
    ["PATCH", "/api/tasks/T-0153"],
    ["DELETE", "/api/tasks/T-0153"],
    ["PUT", "/api/tasks/T-0153"],
    ["POST", "/api/tasks"],
    ["POST", "/api/tasks/T-0153/run"],
    ["POST", "/api/tasks/T-0153/cancel"],
    ["POST", "/api/tasks/T-0153/comments"],
    ["DELETE", "/api/tasks/T-0153/attachments/foo.png"]
  ])("denies %s %s", (method, pathname) => {
    expect(checkAgentCurlRequest({ method, url: `${BOARD}${pathname}` }).allowed).toBe(false);
  });

  it("denies the same mutation through the vite dev server, which proxies /api to the board", () => {
    expect(
      checkAgentCurlRequest({ method: "PATCH", url: `${VITE}/api/tasks/T-0153` }).allowed
    ).toBe(false);
  });

  it("denies a mutation aimed at the board under any loopback spelling", () => {
    for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "[::1]"]) {
      expect(
        checkAgentCurlRequest({ method: "PATCH", url: `http://${host}:4173/api/tasks/T-0153` })
          .allowed
      ).toBe(false);
    }
  });

  it("honours a non-default BOARD_PORT", () => {
    expect(
      checkAgentCurlRequest({
        method: "PATCH",
        url: "http://127.0.0.1:4999/api/tasks/T-0153",
        boardPort: 4999
      }).allowed
    ).toBe(false);
  });

  it("still allows reading the board (GET), which agents legitimately do", () => {
    expect(checkAgentCurlRequest({ method: "GET", url: `${BOARD}/api/tasks/T-0214` }).allowed).toBe(
      true
    );
    expect(
      checkAgentCurlRequest({ method: "GET", url: `${BOARD}/api/tasks/T-0214/attachments` }).allowed
    ).toBe(true);
  });
});

describe("agentCurlPolicy -- the calls agents genuinely need still work", () => {
  it("allows the mandatory attachment upload", () => {
    const verdict = checkAgentCurlRequest({
      method: "POST",
      url: `${BOARD}/api/tasks/T-0214/attachments`,
      args: ["-F", "file=@assets/final/audio/ambience.ogg"]
    });
    expect(verdict.allowed).toBe(true);
  });

  it("allows ComfyUI generation traffic with the flag shapes agents actually use", () => {
    expect(
      checkAgentCurlRequest({
        method: "GET",
        url: `${COMFY}/system_stats`,
        args: ["-s", "--connect-timeout", "5"]
      }).allowed
    ).toBe(true);
    expect(
      checkAgentCurlRequest({
        method: "POST",
        url: `${COMFY}/prompt`,
        args: ["-s", "-H", "Content-Type: application/json", "-d", "@workflow.json"]
      }).allowed
    ).toBe(true);
    expect(
      checkAgentCurlRequest({
        method: "GET",
        url: `${COMFY}/view?filename=out.png`,
        args: ["-s", "-o", "assets/out/frame.png"]
      }).allowed
    ).toBe(true);
  });

  it("allows the ACE-Step / Stable Audio services and public reference downloads", () => {
    expect(checkAgentCurlRequest({ method: "GET", url: "http://172.18.192.1:8001/health" }).allowed).toBe(true);
    expect(checkAgentCurlRequest({ method: "GET", url: "http://172.18.192.1:8002/health" }).allowed).toBe(true);
    expect(
      checkAgentCurlRequest({
        method: "GET",
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg",
        args: ["-fsSL", "-o", "assets/src/lora/corpus/example.jpg"]
      }).allowed
    ).toBe(true);
  });
});

describe("agentCurlPolicy -- the validated method and target cannot be overridden", () => {
  it.each([["-X"], ["--request"], ["--url"], ["--next"], ["-K"], ["--config"], ["-T"], ["--upload-file"], ["-G"]])(
    "rejects %s in the pass-through args",
    (flag) => {
      const verdict = checkAgentCurlRequest({
        method: "GET",
        url: `${COMFY}/system_stats`,
        args: [flag, "PATCH"]
      });
      expect(verdict.allowed).toBe(false);
    }
  );

  it("rejects `--request=PATCH` written with an equals sign", () => {
    expect(
      checkAgentCurlRequest({
        method: "GET",
        url: `${COMFY}/system_stats`,
        args: ["--request=PATCH"]
      }).allowed
    ).toBe(false);
  });

  it("rejects a method override bundled into a short-flag cluster", () => {
    expect(
      checkAgentCurlRequest({ method: "GET", url: `${COMFY}/system_stats`, args: ["-sX", "PATCH"] })
        .allowed
    ).toBe(false);
  });

  it("rejects a second, board-pointing URL smuggled in after an allowed one", () => {
    expect(
      checkAgentCurlRequest({
        method: "GET",
        url: `${COMFY}/system_stats`,
        args: [`${BOARD}/api/tasks/T-0153`]
      }).allowed
    ).toBe(false);
    expect(
      checkAgentCurlRequest({
        method: "GET",
        url: `${COMFY}/system_stats`,
        args: ["127.0.0.1:4173/api/tasks/T-0153"]
      }).allowed
    ).toBe(false);
  });

  it("fails closed on unusable input", () => {
    expect(checkAgentCurlRequest({}).allowed).toBe(false);
    expect(checkAgentCurlRequest({ method: "GET" }).allowed).toBe(false);
    expect(checkAgentCurlRequest({ method: "GET", url: "not a url" }).allowed).toBe(false);
    expect(checkAgentCurlRequest({ method: "GET", url: "file:///etc/passwd" }).allowed).toBe(false);
    expect(checkAgentCurlRequest({ method: "TRACE", url: `${COMFY}/x` }).allowed).toBe(false);
  });
});
