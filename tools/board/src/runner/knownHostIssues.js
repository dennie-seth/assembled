/**
 * Registry of known, unresolved host-state problems that would otherwise cost every card that
 * hits them a full auto-retry cycle before anyone learns the wall is a wall (T-0323, motivated by
 * T-0272/T-0317: four escalation rounds and a human-driven session before "restart ComfyUI with
 * deterministic flags set" surfaced, though it was diagnosable -- and fixable in about two
 * minutes -- from round 9 onward). `hostStatePreflight.js` checks this list before an
 * implementer is ever spawned.
 *
 * Each entry names the host action a human/Dispatch must actually perform -- an agent never
 * applies these itself (docs/design/host-action-escalation.md's Option 2/3 were explicitly
 * deferred as their own privilege-boundary project). Flip `resolved: true` once a human confirms
 * the action was taken and verified per that entry's own `verify` field; never delete a closed
 * entry, so its history stays auditable.
 *
 * An entry can close two ways, and they mean different things:
 *
 *   `resolved: true`  -- a human performed `action` and confirmed it per `verify`.
 *   `withdrawn: true` -- the entry's premise was DISPROVEN. Nobody performed the action, and
 *                        nobody should; doing it is now known to make things worse. Record why in
 *                        `withdrawnReason`. Marking such an entry `resolved` would assert a host
 *                        change that never happened, and deleting it would lose the history.
 *
 * `hostStatePreflight.js` skips both, so either state stops an entry blocking runs.
 */
export const KNOWN_HOST_ISSUES = Object.freeze([
  Object.freeze({
    id: "comfyui-determinism-flags",
    appliesToAgents: ["assets", "audio"],
    // Scopes the block to cards that actually depend on reproducible generation -- an ordinary
    // assets/audio card with no reproducibility requirement was never affected by T-0272/T-0317's
    // finding and must not be preflight-blocked over a wall it would never hit.
    bodyPattern: /reproduc|determinis|byte-identical|identical (?:output|render|hash)|same seed/i,
    host: "Windows ComfyUI host (F:\\ComfyUI)",
    condition:
      "ComfyUI is launched without deterministic PyTorch/CUDA flags, so identical seeds do not reproduce identical " +
      "renders across server lifetimes (T-0272/T-0317 rounds 6-9: attempts 53 and 54 were byte-identical within a " +
      "session and divergent across sessions).",
    action:
      "Edit F:\\ComfyUI\\start-comfyui.bat to set CUBLAS_WORKSPACE_CONFIG=:4096:8 and pass torch's deterministic " +
      "flag (torch.use_deterministic_algorithms(True), cudnn.benchmark=False) on launch, then restart ComfyUI.",
    reason:
      "No agent has a shell on the Windows GPU host; ComfyUI's --listen/--port launch flags and its determinism " +
      "knobs are fixed in a .bat file only a human can edit (T-0317 round 9's diagnosis).",
    verify:
      "Restart ComfyUI, submit the same seed/workflow twice across two separate server lifetimes, and confirm the " +
      "two outputs hash identically.",
    resolved: false,
    // WITHDRAWN 2026-09-08 -- the premise is disproven and the prescribed action is actively harmful.
    // T-0317 rounds 10-12 measured all three regimes on the S24-e dual-IPAdapter + ControlNet graph:
    //
    //   --deterministic + CUBLAS_WORKSPACE_CONFIG : reproducible (attempts 66/67/68 byte-identical,
    //                                               sha256 ff18f51c...d957a on a forced non-cached
    //                                               recompute) but INCOHERENT, 6/6 fresh seeds
    //   CUBLAS_WORKSPACE_CONFIG only              : reproducible (69 == 70) but INCOHERENT, 6/6 seeds
    //   baseline (neither flag)                   : not reproducible, and incoherent 8/8 seeds
    //
    // Determinism was purchased; coherence was not restored and may have been actively excluded. The
    // host was deliberately restored to BASELINE on that evidence, and T-0322's own card records this
    // requirement as "wrong as written and must not be implemented as stated". Reproducibility for
    // this graph is T-0322's open problem (per-graph config / pinning at a different layer), not a
    // flag anyone should set globally.
    withdrawn: true,
    withdrawnReason:
      "Disproven by T-0317 rounds 10-12: the prescribed determinism regime makes the S24-e graph reliably " +
      "incoherent (6/6 seeds under full determinism, 6/6 under CUBLAS-only), so the host was deliberately " +
      "restored to baseline. Nobody performed this action and nobody should; reproducing renders for this " +
      "graph is T-0322's open problem, not a launch flag."
  })
]);
