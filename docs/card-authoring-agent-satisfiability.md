# Card authoring: acceptance criteria must be agent-satisfiable (T-0300)

**Card:** T-0300 — catch agent-impossible acceptance criteria before the implementer runs.

## The problem this closes

`acceptancePreflight.js` (T-0186) already catches "is there a checklist at all". This closes the
next layer: "is the checklist *achievable*". `docs/reviews/2026-09-03-run-lifecycle-state-management.md`
§4.0b names the failure mode "the unsatisfiable-acceptance-criterion class" — a criterion that
demands evidence no agent in this repo can gather reproduces an identical failure signature on
every retry, which the no-progress guard (§23-a) then correctly, but expensively, aborts on. The
guard is working as intended; the card was unrunnable from the moment it was written. Confirmed on
six real cards:

| Card | Impossible criterion | Missing capability |
|---|---|---|
| T-0288 | "drag a tall card… say what you observed; do not infer it from the code" | no browser driver at the time (T-0295 later added one) |
| T-0290 | "state the measured before/after stop duration"; journal evidence of a clean stop | no `Bash(systemctl --user:*)`/`Bash(journalctl --user:*)` grant, and unsafe even with one (`tools/board/DEPLOY.md`: the card runner is a child of the same systemd unit it would restart) |
| T-0273 | AC required byte-fetches from **both** Wikimedia and Openverse while Openverse was down | upstream services rate-limit/timeout independently; fixed at the policy layer by T-0283/T-0284 (`referenceSourcePolicy.js`'s `required: true/false` split), not by rewording the card |
| T-0222 | literal "commit **and open a PR**" | PR-open happens only inside the orchestrator's PASS handler |
| T-0258 | "a PR is opened with CI green" | same circularity, passive voice |
| T-0233 | "`@DennieSeth` approves the sheet" | an agent parking a `requires_approval` card can never write its own approval record |

## The three-way rule

For every acceptance criterion, exactly one of these must be true:

1. **The agent has the capability** — require it, and name the specific tool/command.
2. **The capability can reasonably be added** — add it (the narrow-wrapper pattern:
   `agentCurl.js`, `referenceFetch.js`, T-0295's Playwright harness), then require it.
3. **Neither** — it is a **human-verification step**. Move it out of `## Acceptance` into its own
   section headed exactly:

   ```markdown
   ## Human verification (NOT an agent criterion — does not gate PASS)
   ```

   (the shape T-0288 and T-0290 were reworded to use). An implementer's PASS never depends on this
   section; a human reads and confirms it separately, on their own time, outside the run.

What must never happen is a fourth case: a criterion no agent can ever satisfy left sitting in
`## Acceptance` as if it were case 1 or 2.

## Where this is enforced

`tools/board/src/runner/impossibleAcceptancePreflight.js` is a mechanical, **warn-only** backstop
for exactly this. It runs in `runOrchestrator.js`, immediately after `acceptancePreflight.js` and
`capabilityPreflight.js`, before the implementer child process is spawned, and flags:

- human-observation-only phrasing ("say what you observed", "do not infer it from the code",
  "verify by looking", "confirm visually") — T-0288's exact shape;
- a named operational/browser-driver tool (`systemctl`, `journalctl`, `playwright`, `puppeteer`,
  `selenium`, `chromedriver`, `geckodriver`, `webdriver`) the **assigned** agent has no Bash grant
  for, cross-checked against that agent's real `.claude/agents/<agent>.md` grants — never a
  hardcoded "this tool is always impossible" rule, since impossible-for-`client` can be
  fine-for-`infra` (T-0290's exact shape);
- PR-open/CI-green circularity in either active or passive voice ("open a PR", "a PR is opened
  with CI green") — T-0222, T-0258, and the same shape on T-0288;
- named-human approval circularity ("`@DennieSeth` approves the sheet", "is approved by") —
  T-0233;
- an external reference-source "both/all must succeed" requirement, generated from
  `referenceSourcePolicy.js`'s actual `listSourceIds()` rather than a hardcoded list, so a newly
  added source is covered automatically — generalizes T-0273.

**It warns, it never blocks.** Warnings surface in two places: a run-log event
(`type: "impossible-acceptance-warning"`) and a card comment authored `"assembled-board"` (the
same convention `formatBlockerReportComment`/`parkedForApprovalComment` already use). A false
positive over freeform English must never stop a legitimate card from running — getting the
wording right in the first place is this convention's job, not something a keyword heuristic
should be trusted to gate on. This is deliberately narrower than, and additive to,
`capabilityPreflight.js`'s existing **hard-block** `FORBIDDEN_ACTIONS` check, which already
refuses the active-voice PR/push/merge phrasings outright (T-0222's literal case is still a hard
block via that module) — this new check adds the passive-voice, human-observation,
approval-circularity, and external-source shapes on top, as a non-blocking warning layer.

## What this does NOT change

**The reviewer's fail-closed rule is untouched.** An unrunnable required check is still a FAIL,
not an unverified pass. This card changes what a planner *writes*, never what a reviewer
*accepts*. Nothing here licenses skipping a check the reviewer can run, or treating a warning as
permission to leave a criterion vague.

**No auto-rewriting.** The preflight flags; it never rewrites a criterion. Silently rewording a
human's acceptance criterion would be worse than the original bug.

## Where the planner's guidance for this should live

The natural home for this convention in prose is `.claude/rules/planner.md`, immediately after its
existing "Every acceptance criterion must be independently checkable by the reviewer" bullet —
right next to the related, narrower guidance already there about `requires_approval` cards and the
T-0233 approval-circularity lesson. **That edit could not be made in this session**: every attempt
to write to any file under `.claude/**` was refused by the harness itself
(`"...which is a sensitive file"` / `"...but you haven't granted it yet"`), independent of the
`infra` agent's own documented scope, which explicitly includes `.claude/**`. This is the identical
block T-0286 hit and documented in
`docs/T-0286-claude-instruction-edit-blocked-attempt-log.md` — see
`docs/T-0300-planner-rule-edit-blocked-attempt-log.md` for this session's own confirmation (three
attempts against `planner.md` itself, plus a fourth against the unrelated `js.md`, all refused
identically). Until a session with `.claude/**` write access is available, this document and
`docs/board-invariants.md` §11 are the durable, session-independent record of the convention; the
exact bullet to paste into `planner.md` is included verbatim in the attempt log linked above.
