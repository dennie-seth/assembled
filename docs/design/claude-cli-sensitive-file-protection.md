# The Claude Code CLI's sensitive-file protection and `.claude/**` grants

**Author:** Claude (Sonnet 5)
**Status:** investigated (T-0374) — no board-side or agent-config fix exists; recorded as a hard
CLI limitation, not a solved problem.

## Source

T-0368 / PR #382: the `infra` agent's own definition (`.claude/agents/infra.md`) claims
`.claude/**` as its path scope and grants bare `Write`/`Edit` in its `tools:` frontmatter, but a
live board run denied every edit under `.claude/`. From `tasks/.runs/T-0368-2026-09-12T00-06-33-689Z.jsonl`:

> Claude requested permissions to edit /home/dennieseth/dev/assembled-board/worktrees/T-0368/.claude/rules/planner.md which is a sensitive file.

> Claude requested permissions to write to /home/dennieseth/dev/assembled-board/worktrees/T-0368/.claude/agents/planner.md, but you haven't granted it yet.

T-0368 had to route its fix through `tools/board/src/runner/promptBuilder.js` instead, leaving the
human-readable planner docs out of sync (T-0375, blocked on this card).

## What the denial actually is

**It is not the board's tool list.** `tools/board/src/runner/toolAllowlist.js` correctly resolves
`infra`'s frontmatter into a `--allowedTools` string containing bare `Write` and `Edit` — nothing
in the board's own code narrows or drops that grant before it reaches the CLI invocation
(`claudeCliRunner.js` passes `allowedTools.join(" ")` straight through). Every denial below was
reproduced with that exact resolved grant present in `--allowedTools`.

The denial is the Claude Code CLI's own built-in "sensitive file" safety check
(`decision_reason_type: "safetyCheck"` in the NDJSON stream), which fires for *any* Edit/Write tool
call whose target path falls under `.claude/` — not just `.claude/settings*.json`, the entire tree
— when the session is non-interactive (`-p`, no TTY to show an approval dialog). It fires
regardless of what the resolved `--allowedTools` string contains.

## Live reproduction (2026-09-12, this card)

Reproduced directly against the real CLI (`claude` 2.1.241) in two throwaway git worktrees created
off `origin/develop` for this purpose (`/tmp/t0374-verify-infra`, `/tmp/t0374-verify-client`;
removed after testing, never committed). Each run spawned `claude -p --output-format stream-json
--allowedTools "<grant>"` exactly as `claudeCliRunner.js` does, piping the prompt on stdin, and
asked the model to write a scratch file with the Write tool.

| # | Grant tried | Target | Result |
|---|---|---|---|
| 1 | `infra`'s exact current grant (bare `Write, Edit`, ...) | `.claude/rules/t0374-scratch.md` (new file) | **Denied.** `"Claude requested permissions to edit ... which is a sensitive file."` — reproduces T-0368 exactly. |
| 2 | Path-scoped `Write(.claude/rules/**), Edit(.claude/rules/**)` in `--allowedTools`, alongside the rest of `infra`'s grant | same | **Denied.** Identical `safetyCheck` message. Scoping the pattern to the exact target path does not help. |
| 3 | Same as #2, plus a `--settings` JSON string with `{"permissions":{"allow":["Edit(.claude/rules/**)","Write(.claude/rules/**)"]}}` | same | **Denied.** Persisted/settings-level allow rules go through the same check and lose. |
| 4 | Same grant, `--permission-mode acceptEdits` | same | **Denied.** `acceptEdits` auto-accepts ordinary file edits but the sensitive-file check still fires. |
| 5 | Same grant, plus a `PreToolUse` hook (`.claude/settings.json`-style `hooks` config passed via `--settings`) matching `Write\|Edit` and unconditionally returning `{"hookSpecificOutput":{"permissionDecision":"allow"}}` | same | **Denied.** The hook ran (confirmed via its own side-channel log) and returned `allow`; the built-in check overrode it anyway. |
| 6 | `client`'s exact real grant (bare `Write`/`Edit`, no `.claude` scoping at all — `client.md` doesn't even claim `.claude/**` as scope) | `.claude/rules/t0374-scratch-client.md` (new file) | **Denied.** Same `safetyCheck` message. Confirms the check is path-based, not agent- or grant-based — nothing about `client`'s grant made this any more or less denied than `infra`'s. |
| 7 | `infra`'s grant widened to `Write(.claude/**), Edit(.claude/**)` | `.claude/settings.local.json` (new file) | **Denied**, with the alternate wording `"Claude requested permissions to write to ..., but you haven't granted it yet."` — the same `safetyCheck` reason type, still fires for the settings file specifically even under the broadest `.claude/**` grant tested. |

Every one of rows 1–7 produced `"decision_reason_type":"safetyCheck"` in the stream-json output,
and in every case the model's own follow-up turn correctly identified the write as blocked and
did not retry.

**First-person confirmation, this card's own live session, no throwaway worktree involved:** while
working this exact card, an `Edit` call against this worktree's own
`.claude/agents/infra.md` — adding the candidate `Edit(.claude/agents/*)` / `Write(.claude/rules/*)`
/ etc. grant lines described below — was refused outright:
`"Claude requested permissions to write to .../worktrees/T-0374/.claude/agents/infra.md, but you
haven't granted it yet."` This is the literal catch-22 the card names: the agent whose job is
`.claude/**` cannot write its own definition file, live, on this very card.

**Not tested, and deliberately not tried:** `--dangerously-skip-permissions` /
`--allow-dangerously-skip-permissions` / `--permission-mode bypassPermissions`. This card's own
"Do not" section forbids using any blanket permission-bypass mode, and separately, using it would
also lift the settings-file protection this card is required to keep in place (criterion 3) — a
blanket bypass cannot selectively exempt `.claude/agents/**` while still protecting
`.claude/settings.json`. Publicly, this is the only flag known to disable the check; it is not an
available option for this card's fix.

## Conclusion: there is no grant that lifts this in headless mode

Rows 2–5 above are exactly the fixes a reasonable read of this card's "grant it to the infra agent
only, using the narrowest rule that works" scope would try, in increasing order of how far outside
`--allowedTools` the mechanism could plausibly live: a scoped tool pattern, a settings-level
permission rule, a permission mode, a hook with an explicit allow decision. All four fail
identically. This is a stronger and different finding than the precedent this codebase already has
for a related problem (`tools/board/test/runner/referenceFetchGrant.test.js`, T-0276): there, the
*only* blocked step was the one-time edit of `assets.md` to add a grant string — once a human
applied that edit directly (bypassing the CLI, e.g. with a normal text editor or `git apply`, never
going through a `claude -p` tool call at all), the granted `Bash(...)` tool worked normally forever
after, because the grant's *target* (a plain script under `tools/board/scripts/`) was never itself
a sensitive path.

That escape hatch does not exist here. `.claude/agents/**`, `.claude/rules/**`, and
`.claude/skills/**` are not just hard to grant — they are the sensitive target itself. Even if a
human manually committed a grant like `Edit(.claude/agents/*)` directly into `infra.md` (bypassing
the CLI to make that one edit, the same way PR #301 did for `referenceFetch.js`), the *next* infra
run that tried to use that grant to edit anything under `.claude/` would hit the exact same
`safetyCheck` denial at runtime (row 7 above used that exact shape of grant and was still denied).
Unlike the T-0276 precedent, applying the edit once does not unblock anything going forward.

**This card's outcome, per its own criterion 6 (generalized): no grant — in `toolAllowlist.js`,
`claudeCliRunner.js`, `.claude/settings.json`/`settings.local.json`, or `.claude/agents/infra.md`
itself — makes an automated board run able to edit `.claude/agents/**`, `.claude/rules/**`, or
`.claude/skills/**`. This is reported for a human, not forced.** Until Anthropic exposes a scoped
override for headless (`-p`) sessions, T-0368's existing workaround — encoding `.claude/`-facing
guidance changes in `tools/board/src/runner/promptBuilder.js` instead of the human-readable
`.claude/agents/*.md` / `.claude/rules/*.md` / `.claude/skills/**` files themselves — remains the
only way an automated run can effect an equivalent change. A human continues to be the one who
edits `.claude/agents/**`, `.claude/rules/**`, and `.claude/skills/**` directly, exactly as they
already do for `referenceFetch.js`-style grants (T-0276 / PR #301) and as `.claude/settings.json`
/ `.claude/settings.local.json` already require for every agent.

## What this means for criterion 3 (settings files must stay denied)

Because no grant is being added anywhere, `.claude/settings.json` and `.claude/settings.local.json`
stay denied to every agent, including `infra`, exactly as they always were — there is nothing for
this card to widen. Row 7 above additionally shows that even the broadest plausible `.claude/**`
grant this card could have written does not cover them either way, so there is no config drift risk
in the future if a narrower `.claude/agents/**`-style grant is later hand-applied by a human: as
long as that grant's pattern is written to name `agents/`, `rules/`, and `skills/` explicitly rather
than a bare `.claude/**`, it structurally cannot match the settings files. See
`tools/board/src/runner/claudeSensitiveFileGrant.js` for the candidate pattern set (documented as
non-functional today, kept only so its settings-file exclusion is unit-tested and ready if the CLI
ever exposes a real override) and
`tools/board/test/runner/claudeSensitiveFileGrant.test.js` for the tests.

## Recommended change for a human to apply (not applied by this card)

Per this card's own instructions: since the only theoretically-narrower fix requires editing
`.claude/agents/infra.md` itself, and that edit is refused live (see above), this card stops and
reports the exact change instead of forcing it. If a human wants `infra`'s frontmatter to at least
*declare* the intended scope precisely (matching `tools/board/src/runner/claudeSensitiveFileGrant.js`'s
`CLAUDE_CONFIG_EDIT_GRANT` constant, kept in sync by
`tools/board/test/runner/claudeSensitiveFileGrant.test.js`), the one-line change to
`.claude/agents/infra.md`'s frontmatter `tools:` field is:

```
tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(npm:*), Bash(npx vitest:*), Bash(git:*), Edit(.claude/agents/*), Edit(.claude/rules/*), Edit(.claude/skills/*), Write(.claude/agents/*), Write(.claude/rules/*), Write(.claude/skills/*)
```

**Applying it changes nothing at runtime today** — row 7 above already tested an equivalent
`.claude/**`-scoped grant and it was still denied by the CLI's sensitive-file check. This is offered
only as the config a human would want on hand the day Anthropic exposes a real override for headless
sessions; it is not a fix, and no card should be considered unblocked by applying it alone.

## Cross-reference

See `docs/design/agent-runner.md`'s Guardrails section for the general `--allowedTools`-from-agent-
definition model this sits underneath, and `tools/board/test/runner/referenceFetchGrant.test.js`'s
header comment for the T-0276 precedent this finding extends.

## Appendix: raw NDJSON denial lines

Two of the rows above, verbatim, both `claude` 2.1.241, 2026-09-12:

Row 2 (infra's grant widened with `Write(.claude/rules/**), Edit(.claude/rules/**)`, in
`/tmp/t0374-verify-infra`, session `42fced0b-ba58-45f8-85a0-bc7033d89a1b`):

```json
{"type":"system","subtype":"permission_denied","tool_name":"Write","tool_use_id":"toolu_017GC7i9vFpACZAaSrdAkRbW","decision_reason_type":"safetyCheck","decision_reason":"Claude requested permissions to edit /tmp/t0374-verify-infra/.claude/rules/t0374-scratch.md which is a sensitive file.","message":"Claude requested permissions to edit /tmp/t0374-verify-infra/.claude/rules/t0374-scratch.md which is a sensitive file."}
```

Row 6 (client's real, unmodified grant, in `/tmp/t0374-verify-client`, session
`33701c14-f8ef-48e6-a467-111c1384f49a`):

```json
{"type":"system","subtype":"permission_denied","tool_name":"Write","tool_use_id":"toolu_01DhkT44Rcz3AG4dhdcaWQtR","decision_reason_type":"safetyCheck","decision_reason":"Claude requested permissions to edit /tmp/t0374-verify-client/.claude/rules/t0374-scratch-client.md which is a sensitive file.","message":"Claude requested permissions to edit /tmp/t0374-verify-client/.claude/rules/t0374-scratch-client.md which is a sensitive file."}
```

Byte-for-byte identical `decision_reason_type`/message shape between infra's widened grant and
client's untouched one — the grant played no role in either outcome.
