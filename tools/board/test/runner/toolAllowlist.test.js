import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAllowedTools,
  isToolAllowed,
  parseToolsString,
  READ_ONLY_DEFAULT_TOOLS
} from "../../src/runner/toolAllowlist.js";
import { ClaudeCliRunner } from "../../src/runner/claudeCliRunner.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");

const INFRA_MD = `---
name: infra
description: Implements board tooling.
tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(npm:*), Bash(npx vitest:*), Bash(git:*)
model: sonnet
---

# infra
`;

const REVIEWER_MD = `---
name: reviewer
description: Path-aware, read-only-on-source VALIDATION gate.
tools: Read, Grep, Glob, Bash(npx vitest:*), Bash(ctest:*), Bash(clang-format --dry-run:*), Bash(gdUnit4:*), Bash(git diff:*), Bash(git log:*)
model: opus
---

# reviewer
`;

function fixtureReader(files) {
  return (p) => {
    if (!(p in files)) {
      const err = new Error(`ENOENT: no such file, open '${p}'`);
      err.code = "ENOENT";
      throw err;
    }
    return files[p];
  };
}

describe("parseToolsString", () => {
  it("splits a comma-separated tools string, trimming whitespace", () => {
    expect(parseToolsString("Read, Write, Bash(git:*)")).toEqual(["Read", "Write", "Bash(git:*)"]);
  });

  it("returns an empty array for a non-string input", () => {
    expect(parseToolsString(undefined)).toEqual([]);
  });
});

describe("resolveAllowedTools", () => {
  it("resolves the allowlist from an agent's frontmatter tools: field", () => {
    const readFileFn = fixtureReader({ "/agents/infra.md": INFRA_MD });
    const resolved = resolveAllowedTools("infra", { agentsDir: "/agents", readFileFn });
    expect(resolved).toEqual([
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "Bash(node:*)",
      "Bash(npm:*)",
      "Bash(npx vitest:*)",
      "Bash(git:*)"
    ]);
  });

  it("gives a safe read-only default for agent: null", () => {
    const readFileFn = fixtureReader({});
    expect(resolveAllowedTools(null, { agentsDir: "/agents", readFileFn })).toEqual(
      READ_ONLY_DEFAULT_TOOLS
    );
    expect(READ_ONLY_DEFAULT_TOOLS).not.toContain("Write");
    expect(READ_ONLY_DEFAULT_TOOLS).not.toContain("Edit");
    expect(READ_ONLY_DEFAULT_TOOLS.some((t) => t.startsWith("Bash"))).toBe(false);
  });

  it("gives the same safe read-only default for an unknown agent name, without throwing", () => {
    const readFileFn = fixtureReader({ "/agents/infra.md": INFRA_MD });
    expect(() => resolveAllowedTools("totally-made-up", { agentsDir: "/agents", readFileFn })).not.toThrow();
    expect(resolveAllowedTools("totally-made-up", { agentsDir: "/agents", readFileFn })).toEqual(
      READ_ONLY_DEFAULT_TOOLS
    );
  });

  it("respects the reviewer's read-only tool set (no Write/Edit)", () => {
    const readFileFn = fixtureReader({ "/agents/reviewer.md": REVIEWER_MD });
    const resolved = resolveAllowedTools("reviewer", { agentsDir: "/agents", readFileFn });
    expect(resolved).toContain("Read");
    expect(resolved).toContain("Bash(npx vitest:*)");
    expect(resolved).not.toContain("Write");
    expect(resolved).not.toContain("Edit");
  });

  it("falls back to the safe default when the agent file has malformed frontmatter", () => {
    const readFileFn = fixtureReader({ "/agents/broken.md": "no frontmatter here" });
    expect(resolveAllowedTools("broken", { agentsDir: "/agents", readFileFn })).toEqual(
      READ_ONLY_DEFAULT_TOOLS
    );
  });

  it("resolves against the real repo .claude/agents/infra.md", () => {
    const resolved = resolveAllowedTools("infra", { agentsDir: REAL_AGENTS_DIR });
    expect(resolved).toContain("Read");
    expect(resolved).toContain("Write");
    expect(resolved.some((t) => t.startsWith("Bash(git:"))).toBe(true);
  });

  it("resolves against the real repo .claude/agents/reviewer.md with no Write/Edit", () => {
    const resolved = resolveAllowedTools("reviewer", { agentsDir: REAL_AGENTS_DIR });
    expect(resolved).not.toContain("Write");
    expect(resolved).not.toContain("Edit");
    expect(resolved).toContain("Read");
  });

  it("grants the reviewer a wildcarded .venv/bin/pytest and .venv/bin/ruff so a python-verify package's tests/lint actually run", () => {
    const resolved = resolveAllowedTools("reviewer", { agentsDir: REAL_AGENTS_DIR });

    // T-0072: the reviewer's own Bash call is `.venv/bin/pytest -v` / `.venv/bin/ruff check .`,
    // run once its shell is already cd'd into the package (assets/src/lora) -- not chained
    // after a `cd assets/src/lora && ...`. A `cd assets/src/lora:*` prefix grant never matches
    // that command string, so pytest/ruff need their own generic (non-cwd-scoped) grants.
    expect(resolved).toContain("Bash(.venv/bin/pytest:*)");
    expect(resolved).toContain("Bash(.venv/bin/ruff:*)");

    expect(isToolAllowed("Bash(.venv/bin/pytest:-v)", resolved)).toBe(true);
    expect(isToolAllowed("Bash(.venv/bin/ruff:check .)", resolved)).toBe(true);

    // Not just for lora -- the grant is generic, so it covers every python-verify root
    // (tools/asset-gate, tools/comfy-client, etc.) regardless of which package cwd it runs from.
    const withoutLoraCdGrant = resolved.filter((t) => !t.startsWith("Bash(cd assets/src/lora"));
    expect(isToolAllowed("Bash(.venv/bin/pytest:-v)", withoutLoraCdGrant)).toBe(true);
  });

  it("grants the reviewer a wildcarded pip install so python-verify's exact command string isn't required verbatim", () => {
    const resolved = resolveAllowedTools("reviewer", { agentsDir: REAL_AGENTS_DIR });

    // T-0132: the reviewer's own grant was `Bash(.venv/bin/pip install -e ".[dev]")` with no
    // `:*` -- an exact-match string, same bug class as the #63 fix (missing wildcard). Every
    // form the reviewer actually tried (chained after `cd tools/sim`, relative, absolute) was
    // denied because none of them are byte-for-byte identical to that one exact string.
    expect(resolved).toContain('Bash(.venv/bin/pip install -e ".[dev]":*)');
    expect(resolved).not.toContain('Bash(.venv/bin/pip install -e ".[dev]")');

    expect(isToolAllowed('Bash(.venv/bin/pip install -e ".[dev]":extra-index-url=x)', resolved)).toBe(
      true
    );
  });

  it("grants the server implementer a wildcarded .venv/bin/ruff so it can actually autofix lint on the python/sim cards it's dispatched", () => {
    const resolved = resolveAllowedTools("server", { agentsDir: REAL_AGENTS_DIR });

    // T-0129 (and the rest of the round-3 sim cards, T-0130..T-0133): every one of these is
    // dispatched with agent: "server" despite the changed paths living under tools/sim, and the
    // implementer's own `.venv/bin/ruff check --fix tests/test_identity.py` / `.venv/bin/ruff
    // format` calls were denied outright ("This command requires approval") because server.md
    // granted no ruff invocation at all. With no way to run the actual autofix, the implementer
    // burned all 5 retries editing config instead of fixing the flagged code.
    expect(resolved).toContain("Bash(.venv/bin/ruff:*)");
    expect(isToolAllowed("Bash(.venv/bin/ruff:check --fix tests/test_identity.py)", resolved)).toBe(
      true
    );
    expect(isToolAllowed("Bash(.venv/bin/ruff:format .)", resolved)).toBe(true);
    expect(isToolAllowed("Bash(.venv/bin/ruff:check .)", resolved)).toBe(true);
  });

  it("grants the server implementer python -m ruff, for the module-invocation form of the same autofix", () => {
    const resolved = resolveAllowedTools("server", { agentsDir: REAL_AGENTS_DIR });

    expect(resolved).toContain("Bash(python -m ruff:*)");
    expect(isToolAllowed("Bash(python -m ruff:check --fix .)", resolved)).toBe(true);
  });

  it("grants the server implementer cd tools/sim, so the compound `cd tools/sim && ruff ...` form isn't denied on its first segment", () => {
    const resolved = resolveAllowedTools("server", { agentsDir: REAL_AGENTS_DIR });

    // A compound command's &&-joined segments are matched against the allowlist independently
    // (see the DATABASE_URL/T-0043 precedent above) -- granting ruff alone does not cover a
    // `cd tools/sim && .venv/bin/ruff check --fix ...` invocation unless the `cd tools/sim`
    // segment also has its own matching grant.
    expect(resolved).toContain("Bash(cd tools/sim:*)");

    // The `cd tools/sim` segment of the compound command, matched on its own (independent
    // &&-segment matching, per the T-0043 precedent) -- and the ruff segment, matched by the
    // grant added above. Both must independently match for the full compound invocation to go
    // through unattended.
    expect(
      isToolAllowed("Bash(cd tools/sim:&& .venv/bin/ruff check --fix tests/test_identity.py)", resolved)
    ).toBe(true);
    expect(isToolAllowed("Bash(.venv/bin/ruff:check --fix tests/test_identity.py)", resolved)).toBe(
      true
    );
  });

  it("keeps the server implementer's existing grants (cmake/ctest/clang-format/docker compose/git) intact", () => {
    const resolved = resolveAllowedTools("server", { agentsDir: REAL_AGENTS_DIR });

    expect(resolved).toContain("Read");
    expect(resolved).toContain("Write");
    expect(resolved).toContain("Edit");
    expect(resolved.some((t) => t.startsWith("Bash(cmake:"))).toBe(true);
    expect(resolved.some((t) => t.startsWith("Bash(ctest:"))).toBe(true);
    expect(resolved.some((t) => t.startsWith("Bash(clang-format:"))).toBe(true);
    expect(resolved.some((t) => t.startsWith("Bash(docker compose:"))).toBe(true);
    expect(resolved.some((t) => t.startsWith("Bash(git:"))).toBe(true);
  });

  it("grants the reviewer permission to set DATABASE_URL for server-db-verify", () => {
    const resolved = resolveAllowedTools("reviewer", { agentsDir: REAL_AGENTS_DIR });

    // T-0043: cmake:* and ctest:* were already granted, but the reviewer also needs to set
    // DATABASE_URL (port 5433) ahead of them per the server-db-verify recipe in this file --
    // `export DATABASE_URL=...`, `DATABASE_URL=... ctest`, and `env DATABASE_URL=... ctest`
    // were all denied because none of those forms had a matching grant; `cd server:*` only
    // covers a command that itself starts with "cd server", and each `&&`-joined segment of a
    // compound command is matched independently, so it never covered the DATABASE_URL segment.
    //
    // The first attempt at this fix (#69) used `Bash(export DATABASE_URL=:*)` /
    // `Bash(DATABASE_URL=:*)` / `Bash(env DATABASE_URL=:*)` -- syntactically valid per this
    // file's own prefix-match convention, and it passed this exact test. It still did not work
    // live: verified directly against the real `claude` CLI (v2.1.78, 2026-08-05) that
    // `--allowedTools 'Bash(export FOO=:*)'` denies `export FOO=bar` ("This command requires
    // approval"), while `--allowedTools 'Bash(export FOO=*)'` (bare trailing `*`, no colon)
    // allows it. The `:*` convention only works when the granted prefix ends at a real
    // argument/word boundary (e.g. `Bash(git diff:*)`, `Bash(ctest:*)`) -- it does not work when
    // the wildcard must match a value glued directly onto the prefix via `=` with no space, which
    // is exactly the shape of an inline env-var assignment (`DATABASE_URL=postgresql://...`).
    // Use a bare trailing `*` for that shape instead.
    expect(resolved).toContain("Bash(export DATABASE_URL=*)");
    expect(resolved).toContain("Bash(DATABASE_URL=*)");
    expect(resolved).toContain("Bash(env DATABASE_URL=*)");
    expect(resolved).not.toContain("Bash(export DATABASE_URL=:*)");
    expect(resolved).not.toContain("Bash(DATABASE_URL=:*)");
    expect(resolved).not.toContain("Bash(env DATABASE_URL=:*)");

    expect(
      isToolAllowed("Bash(export DATABASE_URL=postgresql://postgres@localhost:5433/dev)", resolved)
    ).toBe(true);
    expect(
      isToolAllowed(
        "Bash(DATABASE_URL=postgresql://postgres@localhost:5433/dev ctest --test-dir build)",
        resolved
      )
    ).toBe(true);
  });

  it("grants the assets agent both the tilde and absolute-path forms of the shared lora-train-venv interpreter", () => {
    const resolved = resolveAllowedTools("assets", { agentsDir: REAL_AGENTS_DIR });

    // T-0212 root cause: the pre-existing grant `Bash(~/dev/lora-train-venv/bin/python:*)` only
    // covers commands that literally start with the string `~/dev/lora-train-venv/bin/python` --
    // isToolAllowed does raw string-prefix matching with no `~` expansion, no path
    // normalization, no realpath/symlink resolution (see the `isToolAllowed` block below). A
    // live implementer run invoked the identical interpreter via its absolute path,
    // `/home/dennieseth/dev/lora-train-venv/bin/python3 ...` (both a different path form *and*
    // `python3` instead of `python`), and every attempt was denied with "This command requires
    // approval" for the full remainder of the run -- confirmed directly in
    // tasks/.runs/T-0212-2026-08-21T09-57-03-458Z.jsonl, where the implementer had already
    // produced a real ComfyUI generation via the curl grant but could never run the
    // palette-descent post-processing script, and the run was ultimately killed by the 40-minute
    // phase timeout. Same failure class the audio agent hit on T-0202 (see git log
    // .claude/agents/audio.md) -- a grant string that's technically correct for one invocation
    // shape but silently fails to cover the equally-valid alternate shape.
    expect(resolved).toContain("Bash(~/dev/lora-train-venv/bin/python:*)");
    expect(resolved).toContain("Bash(/home/dennieseth/dev/lora-train-venv/bin/python:*)");
    expect(resolved).toContain("Bash(/home/dennieseth/dev/lora-train-venv/bin/python3:*)");
    expect(resolved).toContain("Bash(~/dev/lora-train-venv/bin/python3:*)");
    expect(resolved).toContain("Bash(/home/dennieseth/dev/lora-train-venv/bin/accelerate:*)");

    expect(
      isToolAllowed(
        "Bash(/home/dennieseth/dev/lora-train-venv/bin/python3:assets/src/character/descent_final.py)",
        resolved
      )
    ).toBe(true);
    expect(
      isToolAllowed("Bash(/home/dennieseth/dev/lora-train-venv/bin/python:--version)", resolved)
    ).toBe(true);
  });

  it("grants the assets agent sha256sum so provenance hashes can be computed instead of hand-typed", () => {
    const resolved = resolveAllowedTools("assets", { agentsDir: REAL_AGENTS_DIR });

    // T-0238 root cause: assets.md granted no way at all to compute a sha256 digest -- no
    // sha256sum, no python3 (unlike the audio agent, which has both python3 and .venv/bin/python
    // per d8e3fe5), nothing. Reviewer FAIL notes on T-0230 ("fix(provenance): correct fabricated
    // Arm C hashes — T-0230", commit 37d6d80) and T-0232 (27fb50d: "the recorded hashes did not
    // match the actual sha256 of tile_gen/fields.py or tile_gen/signal_tower_sheet.py"; 7203d64:
    // "Previous commit computed the transitions sidecar's model_hash against fields.py before its
    // final ruff line-length fix landed, so the recorded hash didn't match the committed file")
    // both show the same shape: model_hash/generator_hash values written into
    // ASSET_PROVENANCE.md and the *.provenance.json sidecars were fabricated or went stale
    // relative to the actual committed file, because the implementer had no granted command to
    // compute-and-verify a real digest before writing one down. sha256sum is read-only and
    // side-effect-free, the same minimal-tool shape as the existing `.venv/bin/ruff check` grant.
    expect(resolved).toContain("Bash(sha256sum:*)");
    expect(
      isToolAllowed(
        "Bash(sha256sum:assets/src/tiles/src/tile_gen/fields.py)",
        resolved
      )
    ).toBe(true);
  });
});

describe("isToolAllowed", () => {
  const allowed = ["Read", "Grep", "Glob", "Bash(git:*)", "Bash(npx vitest:*)"];

  it("allows a bare tool name that's in the list", () => {
    expect(isToolAllowed("Read", allowed)).toBe(true);
  });

  it("denies a tool call outside the resolved allowlist", () => {
    expect(isToolAllowed("Write", allowed)).toBe(false);
    expect(isToolAllowed("Edit", allowed)).toBe(false);
  });

  it("allows a Bash(cmd:*) call matching an allowed prefix", () => {
    expect(isToolAllowed("Bash(git:status)", allowed)).toBe(true);
    expect(isToolAllowed("Bash(git:*)", allowed)).toBe(true);
  });

  it("denies a Bash call outside every allowed prefix", () => {
    expect(isToolAllowed("Bash(rm:*)", allowed)).toBe(false);
    expect(isToolAllowed("Bash(curl:*)", allowed)).toBe(false);
  });

  it("denies an unparseable tool string", () => {
    expect(isToolAllowed("", allowed)).toBe(false);
  });

  it("treats a bare trailing `*` (no colon) as a prefix wildcard too", () => {
    // Real Claude Code CLI behavior (verified live, v2.1.78): `Bash(prefix:*)` only matches at a
    // real argument/word boundary. For a value glued directly onto the prefix via `=` (inline
    // env-var assignment, e.g. `DATABASE_URL=...`), the grant must use a bare trailing `*`
    // instead -- `Bash(DATABASE_URL=*)`, not `Bash(DATABASE_URL=:*)`. This matcher must recognize
    // that form as a wildcard too, or a correctly-written live grant looks unmatched here.
    const bareStarAllowed = ["Bash(DATABASE_URL=*)"];
    expect(isToolAllowed("Bash(DATABASE_URL=postgresql://x@localhost:5433/dev)", bareStarAllowed)).toBe(
      true
    );
    expect(
      isToolAllowed(
        "Bash(DATABASE_URL=postgresql://x@localhost:5433/dev ctest --output-on-failure)",
        bareStarAllowed
      )
    ).toBe(true);
    expect(isToolAllowed("Bash(SOMETHING_ELSE=x)", bareStarAllowed)).toBe(false);
  });

  it("does not treat a `~/`-prefixed grant as covering the equivalent absolute-path invocation", () => {
    // T-0212: no `~` expansion or path normalization happens anywhere in this matcher (or in the
    // real Claude Code CLI it models -- see the assets-agent test above). A grant authored with a
    // tilde only ever matches commands that are themselves spelled with that literal tilde; the
    // same binary invoked via its absolute path is a different string and must be granted
    // separately.
    const tildeOnly = ["Bash(~/dev/lora-train-venv/bin/python:*)"];
    expect(isToolAllowed("Bash(~/dev/lora-train-venv/bin/python:script.py)", tildeOnly)).toBe(true);
    expect(
      isToolAllowed("Bash(/home/dennieseth/dev/lora-train-venv/bin/python:script.py)", tildeOnly)
    ).toBe(false);
  });
});

describe("integration: ClaudeCliRunner invocation resolves --allowedTools from the card's agent field", () => {
  it("wires resolveAllowedTools(task.agent) into the built --allowedTools argv", () => {
    const readFileFn = fixtureReader({ "/agents/infra.md": INFRA_MD });
    const task = { id: "T-0055", agent: "infra" };
    const allowedTools = resolveAllowedTools(task.agent, { agentsDir: "/agents", readFileFn });

    const runner = new ClaudeCliRunner({ spawnFn: () => ({}), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task,
      prompt: "build it",
      allowedTools,
      worktreeDir: "/wt/T-0055"
    });

    const idx = invocation.args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(invocation.args[idx + 1]).toBe(allowedTools.join(" "));
    expect(invocation.args[idx + 1]).not.toContain("Bash(rm");
  });

  it("agent: null resolves to the read-only default, never granting Write/Edit/Bash", () => {
    const task = { id: "T-0056", agent: null };
    const allowedTools = resolveAllowedTools(task.agent, { agentsDir: "/agents", readFileFn: fixtureReader({}) });

    const runner = new ClaudeCliRunner({ spawnFn: () => ({}), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task,
      prompt: "look around only",
      allowedTools,
      worktreeDir: "/wt/T-0056"
    });

    const idx = invocation.args.indexOf("--allowedTools");
    expect(invocation.args[idx + 1]).toBe(READ_ONLY_DEFAULT_TOOLS.join(" "));
  });
});
