/**
 * T-0208 (HANDOFF §20-e1, `docs/PLAN.md` Phase 8) — "CI-built client is
 * downloadable from a GitHub release" is a property of the release
 * workflows, not something this repo's own test runner can exercise
 * end-to-end (that needs a real `v*` tag push against GitHub Actions).
 * These tests pin the load-bearing structure of `release.yml` and
 * `latest-release.yml` so a future edit that quietly breaks the download
 * path — wrong trigger, a build job dropped from `needs`, an artifact name
 * that no longer matches what `ci-client.yml` uploads, publishing turned
 * off — fails here instead of only being discovered at the next tag cut.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const RELEASE_YML = path.join(WORKFLOWS_DIR, "release.yml");
const LATEST_RELEASE_YML = path.join(WORKFLOWS_DIR, "latest-release.yml");
const CI_CLIENT_YML = path.join(WORKFLOWS_DIR, "ci-client.yml");

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function loadRaw(file) {
  return fs.readFileSync(file, "utf8");
}

describe("T-0208 release artifact — ci-client.yml exposes reusable client build outputs", () => {
  let doc;
  beforeAll(() => {
    doc = loadYaml(CI_CLIENT_YML);
  });

  it("is triggerable as a reusable workflow (workflow_call)", () => {
    // YAML parses the bare `on:` key as boolean `true` in js-yaml's default
    // schema, so read the raw text for the trigger keys instead of doc.on.
    expect(loadRaw(CI_CLIENT_YML)).toMatch(/workflow_call:/);
  });

  it("still defines windows-export and linux-export jobs", () => {
    expect(doc.jobs).toHaveProperty("windows-export");
    expect(doc.jobs).toHaveProperty("linux-export");
  });

  it("uploads artifacts named client-windows-export and client-linux-export", () => {
    const raw = loadRaw(CI_CLIENT_YML);
    expect(raw).toContain("name: client-windows-export");
    expect(raw).toContain("name: client-linux-export");
  });
});

describe("T-0208 release artifact — release.yml (tagged releases)", () => {
  let doc;
  beforeAll(() => {
    doc = loadYaml(RELEASE_YML);
  });

  it("triggers only on v* tag pushes, never on branch push or PR", () => {
    expect(doc.on.push.tags).toEqual(expect.arrayContaining(["v*"]));
    expect(doc.on.push.branches).toBeUndefined();
    expect(doc.on.pull_request).toBeUndefined();
  });

  it("builds the client by reusing ci-client.yml, not by duplicating its steps", () => {
    expect(doc.jobs["build-client"].uses).toBe("./.github/workflows/ci-client.yml");
  });

  it("publish-release depends on the client build finishing first", () => {
    const needs = doc.jobs["publish-release"].needs;
    expect(Array.isArray(needs) ? needs : [needs]).toContain("build-client");
  });

  it("downloads both platform client artifacts by the exact names ci-client.yml uploads", () => {
    const steps = doc.jobs["publish-release"].steps;
    const downloadNames = steps
      .filter((s) => s.uses && s.uses.startsWith("actions/download-artifact"))
      .map((s) => s.with && s.with.name);
    expect(downloadNames).toContain("client-windows-export");
    expect(downloadNames).toContain("client-linux-export");
  });

  it("publishes a non-draft, non-prerelease GitHub Release carrying the packaged zips", () => {
    const publishStep = doc.jobs["publish-release"].steps.find(
      (s) => s.uses && s.uses.startsWith("softprops/action-gh-release")
    );
    expect(publishStep, "no softprops/action-gh-release step found").toBeTruthy();
    expect(publishStep.with.draft).toBe(false);
    expect(publishStep.with.prerelease).toBe(false);
    expect(publishStep.with.files).toMatch(/release\/\*\.zip/);
  });

  it("grants contents: write only to the job that actually publishes the release", () => {
    expect(doc.permissions.contents).toBe("read");
    expect(doc.jobs["publish-release"].permissions.contents).toBe("write");
  });
});

describe("T-0208 release artifact — latest-release.yml (rolling develop build)", () => {
  let doc;
  beforeAll(() => {
    doc = loadYaml(LATEST_RELEASE_YML);
  });

  it("triggers on every push to develop", () => {
    expect(doc.on.push.branches).toEqual(expect.arrayContaining(["develop"]));
  });

  it("builds the client by reusing ci-client.yml", () => {
    expect(doc.jobs["build-client"].uses).toBe("./.github/workflows/ci-client.yml");
  });

  it("publishes a prerelease under a stable, fixed tag rather than accumulating a release per commit", () => {
    const publishStep = doc.jobs["publish-latest"].steps.find(
      (s) => s.uses && s.uses.startsWith("softprops/action-gh-release")
    );
    expect(publishStep, "no softprops/action-gh-release step found").toBeTruthy();
    expect(publishStep.with.tag_name).toBe("latest");
    expect(publishStep.with.prerelease).toBe(true);
  });

  it("downloads both platform client artifacts before packaging", () => {
    const steps = doc.jobs["publish-latest"].steps;
    const downloadNames = steps
      .filter((s) => s.uses && s.uses.startsWith("actions/download-artifact"))
      .map((s) => s.with && s.with.name);
    expect(downloadNames).toContain("client-windows-export");
    expect(downloadNames).toContain("client-linux-export");
  });
});
