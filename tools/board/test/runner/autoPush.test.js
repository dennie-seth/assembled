import { describe, it, expect, vi, afterEach } from "vitest";
import { attemptPush, schedulePush, autoPushOnCommitFromEnv } from "../../src/runner/autoPush.js";

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function nonFastForwardError() {
  return new Error(
    "git push -u origin develop failed: ! [rejected]        develop -> develop (fetch first)\nerror: failed to push some refs"
  );
}

describe("autoPushOnCommitFromEnv", () => {
  const original = process.env.AUTO_PUSH_ON_COMMIT;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AUTO_PUSH_ON_COMMIT;
    } else {
      process.env.AUTO_PUSH_ON_COMMIT = original;
    }
  });

  it("defaults to true when unset", () => {
    delete process.env.AUTO_PUSH_ON_COMMIT;
    expect(autoPushOnCommitFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "FALSE", "Off"])("is false when set to %s", (value) => {
    process.env.AUTO_PUSH_ON_COMMIT = value;
    expect(autoPushOnCommitFromEnv()).toBe(false);
  });
});

describe("attemptPush", () => {
  it("pushes directly and reports success when origin accepts it first try", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const mergeNoFF = vi.fn();
    const logger = makeLogger();

    const result = await attemptPush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger });

    expect(result).toEqual({ pushed: true, retried: false });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ worktreeDir: "/repo", branch: "develop" });
    expect(mergeNoFF).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never passes force: true to push, even on retry", async () => {
    const push = vi.fn().mockRejectedValueOnce(nonFastForwardError()).mockResolvedValueOnce(undefined);
    const mergeNoFF = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();

    await attemptPush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger });

    for (const call of push.mock.calls) {
      expect(call[0]).not.toHaveProperty("force", true);
    }
  });

  it("on a non-fast-forward rejection, reconciles with mergeNoFF and retries the push exactly once", async () => {
    const push = vi.fn().mockRejectedValueOnce(nonFastForwardError()).mockResolvedValueOnce(undefined);
    const mergeNoFF = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();

    const result = await attemptPush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger });

    expect(result).toEqual({ pushed: true, retried: true });
    expect(push).toHaveBeenCalledTimes(2);
    expect(mergeNoFF).toHaveBeenCalledTimes(1);
    expect(mergeNoFF).toHaveBeenCalledWith({ repoRoot: "/repo", branch: "develop" });
  });

  it("does not retry a non-non-fast-forward failure (e.g. unreachable origin) -- logs a warning and stops", async () => {
    const push = vi.fn().mockRejectedValue(new Error("ssh: connect to host origin port 22: Connection refused"));
    const mergeNoFF = vi.fn();
    const logger = makeLogger();

    const result = await attemptPush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger });

    expect(result).toEqual({ pushed: false, retried: false, reason: "push-failed" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(mergeNoFF).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("when the reconcile merge itself fails (persistent conflict), logs a warning and does not retry the push", async () => {
    const push = vi.fn().mockRejectedValue(nonFastForwardError());
    const mergeNoFF = vi.fn().mockRejectedValue(new Error("CONFLICT (content): Merge conflict in tasks/T-0001.md"));
    const logger = makeLogger();

    const result = await attemptPush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger });

    expect(result).toEqual({ pushed: false, retried: false, reason: "merge-failed" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(mergeNoFF).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("when the retried push also fails, logs a warning and gives up (no further retries)", async () => {
    const push = vi.fn().mockRejectedValue(nonFastForwardError());
    const mergeNoFF = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();

    const result = await attemptPush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger });

    expect(result).toEqual({ pushed: false, retried: true, reason: "retry-push-failed" });
    expect(push).toHaveBeenCalledTimes(2);
    expect(mergeNoFF).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("never throws -- every failure path resolves with a result object instead of rejecting", async () => {
    const push = vi.fn().mockRejectedValue(new Error("origin unreachable"));
    const mergeNoFF = vi.fn();
    const logger = makeLogger();

    await expect(
      attemptPush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger })
    ).resolves.toMatchObject({ pushed: false });
  });
});

describe("schedulePush", () => {
  it("returns immediately without awaiting the push (fire-and-forget)", async () => {
    let resolvePush;
    const push = vi.fn(() => new Promise((resolve) => (resolvePush = resolve)));
    const mergeNoFF = vi.fn();
    const logger = makeLogger();

    const returnValue = schedulePush({
      repoRoot: "/repo",
      branch: "develop",
      git: { push, mergeNoFF },
      logger,
      enabled: true
    });

    // The whole point of schedulePush is that it never makes the caller wait on git -- it
    // returns synchronously, before the push (chained onto the module's serialization
    // promise) has even started.
    expect(returnValue).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(push).toHaveBeenCalledTimes(1);
    resolvePush();
    // Let the chain settle so it doesn't leave a pending promise behind for later tests.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does nothing at all when enabled is false", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const mergeNoFF = vi.fn();
    const logger = makeLogger();

    schedulePush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger, enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(push).not.toHaveBeenCalled();
  });

  it("a push failure is swallowed -- schedulePush never produces an unhandled rejection", async () => {
    const push = vi.fn().mockRejectedValue(new Error("origin unreachable"));
    const mergeNoFF = vi.fn();
    const logger = makeLogger();

    expect(() =>
      schedulePush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger, enabled: true })
    ).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logger.warn).toHaveBeenCalled();
  });

  it("serializes two overlapping schedulePush calls instead of running them concurrently", async () => {
    const order = [];
    let releaseFirst;
    const push = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => {
              order.push("first-push-start-was-first");
              resolve();
            };
          })
      )
      .mockImplementationOnce(async () => {
        order.push("second-push-ran-after-first-resolved");
      });
    const mergeNoFF = vi.fn();
    const logger = makeLogger();

    schedulePush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger, enabled: true });
    schedulePush({ repoRoot: "/repo", branch: "develop", git: { push, mergeNoFF }, logger, enabled: true });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(push).toHaveBeenCalledTimes(1);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(push).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["first-push-start-was-first", "second-push-ran-after-first-resolved"]);
  });
});
