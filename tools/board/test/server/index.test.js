import { describe, it, expect, vi, afterEach } from "vitest";

describe("board server entry point: last-resort crash guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../../src/server/boardServer.js");
  });

  it("installs uncaughtException/unhandledRejection handlers that log and never call process.exit", async () => {
    vi.doMock("../../src/server/boardServer.js", () => ({
      startBoardServer: vi.fn(async () => ({ server: { address: () => ({ port: 4173 }) } }))
    }));

    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit must never be called by the crash guard");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../src/server/index.js");

    const uncaughtHandler = onSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
    const rejectionHandler = onSpy.mock.calls.find(([event]) => event === "unhandledRejection")?.[1];
    expect(typeof uncaughtHandler).toBe("function");
    expect(typeof rejectionHandler).toBe("function");

    // Call the captured handler functions directly rather than process.emit(...) -- emitting on
    // the real process object would also dispatch to every other uncaughtException/
    // unhandledRejection listener already attached to this shared test-runner process
    // (including the test framework's own), which is unrelated to what this guard does and
    // risky to trigger for real inside a test run. Invoking the reference in isolation is
    // enough to prove the guard itself logs and survives.
    expect(() => uncaughtHandler(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }))).not.toThrow();
    expect(() => rejectionHandler(new Error("boom"))).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("uncaughtException"), expect.any(Error));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unhandledRejection"), expect.any(Error));
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
