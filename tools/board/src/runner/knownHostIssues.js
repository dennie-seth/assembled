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
// No entries are currently seeded. The original worked example (T-0323),
// `comfyui-determinism-flags`, was withdrawn (T-0345, PR #355) and then removed outright (T-0346):
// its premise -- "determinism flags broke coherence" -- was never established. 0/6 and 0/8
// fresh-seed coherence under the two flag regimes (T-0317 rounds 10-12) is indistinguishable from
// chance against this graph's own baseline coherence rate (roughly 1/40 across earlier rounds;
// baseline itself scored 0/8 on the same reroll). The live ComfyUI regime stays at baseline -- it
// carries no cost -- but that is no longer recorded here as a "finding" the flags disproved.
export const KNOWN_HOST_ISSUES = Object.freeze([]);
