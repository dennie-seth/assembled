/**
 * T-0357: the single authoritative character validator's CLI invocation,
 * shared verbatim between `ci-asset-gate.yml`'s `character-gate` job and
 * `verifyRouter.js`'s `character-gate-verify` route. Neither side hand-copies
 * this string -- the workflow embeds it directly and the route builds its
 * command from this same constant, so the two enforcement paths cannot
 * silently drift apart the way `character-motion-fidelity-sweep` did before
 * this card (implemented and unit-tested, but never invoked by any workflow
 * or reviewer route -- Codex review 2026-09-11 finding 1).
 *
 * `../../assets/final` / `--repo-root ../../` are relative to
 * `tools/asset-gate`, the working directory both the CI job (via its
 * `defaults.run.working-directory`) and the reviewer route (via its own
 * `cd tools/asset-gate &&` prefix) run from.
 */
export const CHARACTER_GATE_CLI_ARGS =
  "asset_gate.cli character-gate ../../assets/final --repo-root ../../";
