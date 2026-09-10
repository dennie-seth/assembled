# Host-action escalation

**Status:** implemented (Option 1 + Option 4; see [[../decision-log.md]] DL-29). **Owning
code:** `tools/board/src/lib/hostActionRequest.js`, `tools/board/src/runner/blockerReport.js`,
`tools/board/src/lib/escalationRemediation.js`, `tools/board/src/runner/knownHostIssues.js`,
`tools/board/src/runner/hostStatePreflight.js`, `tools/board/src/runner/runOrchestrator.js`
(`_blockOnHostAction`, `_recordBlockerReport`), `tools/board/src/runner/promptBuilder.js`
(`FOOTER_SECTION`) and `tools/board/src/runner/reviewerPrompt.js` (`VERDICT_FOOTER`) -- where
every implementer and reviewer run is actually taught the fenced format exists. Extends
[[escalation-workflow.md]] -- read that first; this document only covers what's different for a
host-only blocker.

## Problem (T-0323)

A board agent runs inside a WSL worktree with no shell on the Windows host where ComfyUI, the
GPU, and the training stack live. When a card's failure traces to host configuration, the agent
can diagnose the problem in complete, correct detail and still cannot fix it -- and until this
card, it had no way to say so except prose a human has to read and interpret.

**The motivating incident:** T-0272/T-0317's profile keyframe took four escalation rounds (6-9)
to get from "the render doesn't reproduce" to a merged fix. Round 9 correctly named the exact
remedy -- edit `F:\ComfyUI\start-comfyui.bat` to set `CUBLAS_WORKSPACE_CONFIG` and a
`torch.use_deterministic_algorithms` flag, then restart -- and correctly named why the agent
itself couldn't apply it: no shell on the host, launch flags fixed in a `.bat` file. That
diagnosis sat in a blocker report's prose for four rounds before a human-driven session applied
it. The fix itself was about two minutes of work. The gap was entirely "how does an agent hand
this off," not "can an agent figure it out."

The existing escalation path ([[escalation-workflow.md]]) *did* fire (T-0321) and was closed as
"nothing for Dispatch to do," because at that moment the remediation looked like ordinary merged
code. The taxonomy had no word for "this needs a host shell" as a category distinct from
"code/test bug" or "external service" -- so it read as one of those, was actioned as one of
those, and the actual, narrower ask (edit one file on one host, restart one process) never got
surfaced as its own thing.

## Options considered

1. **A host-action escalation category.** Extend `blockerReport.js`'s taxonomy with a
   `host-action` category carrying a *structured* payload (host, action, reason, verify) instead
   of free prose, and render it distinctly wherever a blocker report or remediation card shows
   up. Cheapest: no new execution surface, no new privilege boundary, reuses every piece of the
   existing dispatch-card machinery (`escalationRemediation.js`'s dedupe/supersede/dependency
   wiring) as-is. Costs: still fully human-driven -- a human (or Dispatch) still performs the
   host action by hand, nothing gets faster the first time a *new* kind of host issue appears.

2. **A dispatch-runnable host action.** A narrow, allowlisted set of host operations
   (restart ComfyUI, read a launcher file, set one documented flag) that a Dispatch-class card
   may execute directly, everything else refused. More capable -- the fix could land without a
   human touching the host at all for the allowlisted cases. Costs: this is a privilege boundary
   into a Windows host from a WSL sandbox. The allowlist has to be explicit, small, and
   auditable, which means designing and reviewing an execution surface (what transport reaches
   the host, what confirms an action actually ran, what stops the allowlist from silently
   growing) as its own project -- disproportionate to a single P2 card whose worked example is a
   two-line `.bat` edit.

3. **A host-side agent or shim** with its own scoped grants, invoked over a local endpoint. Most
   capable (an actual standing agent on the host side, not just a one-shot allowlisted command),
   and correspondingly the most to build and secure: a new service, its own auth story, its own
   audit trail, running on the one machine this project has said (`CLAUDE.md`'s network-binding
   rule) should never expose a shell to anything. Right-sized for a future card if host actions
   turn out to recur often enough to justify standing infrastructure; wrong-sized for this one.

4. **Preflight the known host state.** A small, explicit registry of already-diagnosed,
   unresolved host problems, checked before the implementer is ever spawned -- so a card that
   would hit a known wall is told immediately instead of after `MAX_AUTO_RETRY_ATTEMPTS` cycles.
   Cheap, additive, no new privilege surface (it's a lookup against a list a human edits by hand
   when they fix or discover something). Doesn't help with a *novel* host issue nobody has
   diagnosed yet -- that still has to go through the reactive path (option 1) at least once.

## Decision

**Option 1 + Option 4, both implemented by this card.** Option 1 gives the agent vocabulary to
say "this needs a host shell" precisely, the first time it hits a wall. Option 4 makes sure the
*next* card that would hit the *same*, already-diagnosed wall never has to rediscover it --
exactly the pairing the card brief calls out ("option 4's preflight should ship with it -- the
cheapest half of the value is telling the agent early that the wall is a wall"). Neither adds
any new execution surface: nothing in this change lets an agent (or Dispatch) touch the host
directly, which is the explicit non-goal of this card ("do not grant broad host shell access,"
"do not solve this by having agents SSH/`wsl.exe` out of their sandbox").

Options 2 and 3 are deferred, not rejected. If host issues start recurring often enough that a
human manually applying a two-line `.bat` edit becomes the bottleneck rather than the diagnosis,
option 2's narrow allowlist is the next step -- and this card's structured `{host, action,
reason, verify}` payload is exactly the shape a future allowlisted executor would need as its
input, so nothing here needs to be redone to get there.

## Mechanism

### The structured request (Option 1)

`hostActionRequest.js` defines a fenced, machine-parseable block:

````
```host-action-request
host: <where>
action: <what to do, concretely -- a file to edit, a flag to set, a service to restart>
reason: <why an agent can't do this itself>
verify: <how to confirm the action worked>
```
````

`formatHostActionRequest` builds one; `parseHostActionRequest` extracts one from arbitrary text,
returning `null` unless all four fields are present -- a partial block is not actionable and
must not be mistaken for a genuine request.

`blockerReport.js`'s `categorizeFailure` checks for this block *before* any keyword heuristic:
a structural, unambiguous match always wins over a regex guess. The new `host-action` category
sits first in `BLOCKER_CATEGORIES`. `buildBlockerReport` carries the parsed payload through as
`report.lacks.hostAction`; `formatBlockerReportComment` and `escalationRemediation.js`'s
`draftRemediationCard` both render it as labeled `Host`/`Action`/`Reason`/`Verify` fields --
never folded back into a single prose sentence -- and the remediation card's `## Acceptance`
section asks for the named action and the named verification specifically, not a generic "root
cause resolved."

Nothing about the fenced format is guessable from first principles, so both the implementer and
reviewer prompts teach it explicitly (`promptBuilder.js`'s `FOOTER_SECTION`, `reviewerPrompt.js`'s
`VERDICT_FOOTER` -- `.claude/rules/conduct.md` was the first choice, since it already reaches
every agent, but the harness treats `.claude/rules/*.md` as a protected file the implementer
agent cannot edit, so the instruction lives in the prompt builders instead). An implementer that
reaches this wall mid-run is told to emit the fenced block in its own notes/commit/comment the
moment it hits the wall; the reviewer is told to look for that block (or diagnose one itself) and
carry it forward verbatim inside its FAIL verdict's `notes` field -- the one piece of text
`blockerReport.js` actually reads (per [[escalation-workflow.md]]). `categorizeFailure` also
keeps a narrow prose-keyword fallback (`no shell`, `host-only`, `host-side`, `Windows host`, ...)
for a diagnosis that names the wall correctly but never reaches the fenced form -- a lower-
confidence catch, checked only after the structural block match, for exactly the T-0321 failure
mode this card exists to close.

### The preflight (Option 4)

`knownHostIssues.js` is a short, hand-maintained registry: each entry names the agents it
applies to, the host, the condition, and the same four `{host, action, reason, verify}` fields.
`hostStatePreflight.js`'s `checkHostStatePreflight` runs in `runOrchestrator.js`'s
`_runCardInWorktree`, in the same preflight slot as `checkCapabilityPreflight` (before the
implementer is spawned) -- an active, unresolved entry that applies to the card's assigned agent
blocks the card immediately via `_blockOnHostAction`, which builds the identical structured
report shape `_escalateIfGenuineBlocker` would have built after five wasted attempts, and routes
it through the same `_recordBlockerReport` comment/remediation-card/dependency-wiring path.
Zero implementer attempts are spent on a wall already named.

The registry's original worked example was the T-0272/T-0317 ComfyUI determinism entry
(`appliesToAgents: ["assets", "audio"]`, `resolved: false`). A human flips `resolved: true` once a
host action is taken and verified per the entry's own `verify` field -- a closed entry is normally
kept rather than deleted, so a settled issue's history stays auditable. That entry instead ended up
`withdrawn` (T-0345, PR #355): the coherence regression it named was never established as real,
0/6 and 0/8 fresh-seed samples under the flag regimes being indistinguishable from chance against
this graph's own ~1-in-40 baseline rate. A withdrawn entry with no real history to preserve -- as
opposed to one whose premise was actually disproven -- can be deleted outright, and T-0346 did so;
the registry (`KNOWN_HOST_ISSUES` in `knownHostIssues.js`) is currently empty.

## What this does not do

- It does not let any agent or Dispatch card touch the host. Every host action named by either
  mechanism is still performed by a human.
- It does not grant a new tool, Bash prefix, or network path to any agent.
- It does not replace `escalation-workflow.md`'s existing categories or its dispatch-card
  machinery -- `host-action` is an addition to `BLOCKER_CATEGORIES`, checked first, everything
  else (dedupe, supersede, dependency wiring, the `dispatch` sentinel and its pick-up-loop skip)
  is reused unchanged.
