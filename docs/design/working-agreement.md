# Working agreement — Claude + Codex assisted-autonomy sprints

Status: v2, 21 October 2026. Drafted by Claude (Lead Dev / Tech Lead), revised to incorporate Codex's design review. For Dennie's sign-off. Nothing here is active until the prerequisites in the last section are built and tested. This is the human-readable contract; the enforceable version lives in the board's versioned sprint contract and gates, which the deterministic coordinator enforces.

## Who owns what

- **Dennie — product owner & release authority.** Sets the sprint plan at Friday planning (goals, acceptance criteria, architecture/design decisions, which tickets or narrowly-defined classes are auto-merge-eligible, budget, authority). Owns all scope, protected-action and values decisions. Is the *only* one who promotes `develop` → `main`.
- **Claude — Lead Developer / Tech Lead.** Implementation lead; owns technical decomposition within the approved contract, drafts acceptance contracts, proposes solutions to review disagreements. **This role is not independent approval of my own work** — see peer review.
- **Codex — primary independent reviewer.** Does the reviews (code/behavior/acceptance, unresolved-risk reports). May implement *explicitly assigned* fixes, but only as a separate implementation job in its own branch, which Claude then reviews.

Neither role can override a failed independent review, weaken a frozen acceptance criterion to pass its own work, or expand its own permissions. The deterministic coordinator enforces the approved contract; no verdict or comment from either agent can widen a job's permissions or flip a protected flag.

## Branches & releases

- **`develop`** is the integration branch (the repo's actual branch name; there is no `dev`). Claude works here and in feature branches off it.
- **`main`** is the stable, playable branch — the blessed result of a sprint. **Only Dennie promotes `develop` → `main`.** Neither agent ever writes to `main`.
- **Deployment consequence (important):** the live board auto-pulls and restarts from `develop` on every merge. So an automatic merge to `develop` *is* a deployment. Either that consequence is explicitly part of the approved auto-merge class, or the pilot runs on an isolated integration branch first — Dennie's call (see open decision). We do not add a second deployment path or bypass the existing deploy guards.

## The merge rule

Plan-conformance is **necessary but not sufficient.** A change may merge automatically to the integration branch only when all hold:

1. it belongs to the **approved sprint scope**;
2. it has **explicit human approval for low-risk auto-merge** — per ticket, or a narrowly-defined class granted at planning (an agent calling its own change "low risk" is not approval);
3. it **passes independent review** of its exact final head and criteria version;
4. it **passes required checks** (and, where the merge deploys, integration validation);
5. there is **no outstanding human gate**.

Everything else stays *review-ready pending the right decision* — reported separately from *delivered*. Once the approved conditions are met, no repeated confirmation is needed. A change that departs from the plan — altering an architecture or design decision made at planning, or adding unapproved scope — is a planning-session conversation, not something to merge. An architecture decision made at planning stays a planning decision even when the departure is "just technical."

## Peer review — author is never reviewer, no unreviewed writes

**Every final patch is reviewed by the other agent before it integrates** — bound to the exact final commit and criteria version; any later code change invalidates the approval. There is no "trivial change skips review" exception: a test fixup or "applying an agreed finding" can still change behavior or weaken evidence, and an agreed finding approves the *intended remedy*, not an unseen final patch. Genuinely mechanical changes get a *short* review, not a direct unreviewed write.

- Claude implements → **Codex reviews** → integrate.
- A fix by **Codex** is a separately-authorized implementation job in its own branch → **Claude reviews** → integrate.

The reviewer adapter is **read-only on source.** Publishing a verdict is a separate, narrowly-scoped board operation. No permission profile is ever both "read-only" and "may modify code." Reading source to review never, by itself, grants merge authority.

## Always human-authorized — even when technical

Credentials, permissions or tool grants; the admission / budget / usage gates; destructive data migrations; promotion of art to `final`; the strictly-open-source-model rule for art; deploy / service / systemd configuration; and any update to `main`. Claude may *triage and recommend* a protected technical fix, but recommending is not authorizing — these need Dennie's explicit approval of the action and its scope. The coordinator enforces this; a verdict can't turn on a protected flag.

## How we communicate — the board is the mailbox

Neither agent watches the other's chat. We exchange durable records on the board, and board-state changes are the trigger:

- Claude finishes → pushes the commit → flips the card to *review* with a compact handoff: ticket/sprint ID, acceptance-criteria version, branch, **exact commit SHA**, changed-file summary, test-evidence references, findings, prior attempts (by reference — never replay chat histories).
- That wakes Codex's review as a *board job*: it reads the handoff, reviews the exact commit, and a **deterministic board publisher** validates identity, schema and the *current* head before appending one verdict (job/ticket/sprint identity, reviewed SHA, criteria version, PASS / CHANGES_REQUESTED / BLOCKED, findings with file·line·evidence, checks performed, limitations). A failed process or invalid result is **BLOCKED, never PASS.** If the head changed during review, the result is retained but marked **superseded** and a review of the new head is requested.
- The verdict wakes whoever owns the next step.

Event-driven, with a periodic **reconciliation sweep** so a dropped event still gets caught (the same net as auto-done-on-merge). After two unsuccessful repair/review rounds on the same issue — or a review disagreement that survives the cap — the ticket is **parked with a concise decision request**, and we continue other eligible work. No unbounded repair or argument loop.

## Reaching Dennie

One decision inbox and a single Friday digest for routine progress — no notification flood. Urgent escalation only for: suspected data loss or security impact, unexpected spend, a credential/purchase decision, or a blocker that leaves no safe in-scope work and threatens the sprint. Each states: what happened, impact on the goal, what was already tried, two realistic options, the recommended one, and the exact decision needed. **Silence is never approval** — if a decision is needed and Dennie can't be reached, the affected lane holds and we continue only other safe, in-scope work.

## Calendar & capacity (part of the contract, not optional)

- **Hours (confirmed):** Monday–Thursday 09:00–18:00 Europe/Budapest (honoring DST); Friday 16:00 retro/planning; **weekends off.** *Every* launch path shares this calendar — the existing poller, retries, reviews, and any paid telemetry probe, not just a new schedule. Checkpoint before cutoff; a weekend reboot does not replay missed jobs.
- **Capacity (policy to approve):** budget each provider independently; **reserve review capacity before starting implementation**; hold the affected lane on unknown/stale/incomparable usage; no automatic paid fallback, credit purchases or account changes; bounded retries and per-job runtime limits.

## Readiness — the adapter is milestone 1, not the finish line

A working reviewer adapter alone does **not** authorize unattended sprints. Readiness also requires: the shared calendar gate on all launch paths; the capacity/admission gates (the T-0402 / T-0438 / T-0439 work); durable job ownership with crash reconciliation; exact-head validation; pause/cancellation that actually takes effect; and **tested** app-notification delivery (selecting the channel is not proof it emits; a powered-off machine can't raise its own alarm).

**First milestone (T-0460) — a bounded, manually-initiated, review-only board job:** prove that the board's actual execution context can invoke Codex and get back one real structured verdict, on this machine — reusing the board's runner/reservations/planned exact-head/receipt/event-wake work, not a second coordinator. "It does not work here, with evidence" is an acceptable outcome. This is an integration test, not activation of the sprint loop.

## Open decision for Dennie

Does the pilot auto-merge directly to the live `develop` (accepting that each auto-merge restarts the running board, and folding that into the approved low-risk class), or run on an **isolated integration branch** first and promote in batches? Claude's lean: isolate the pilot, since the first auto-merges are exactly when we most want a buffer between "agents merged it" and "the live board restarted on it."
