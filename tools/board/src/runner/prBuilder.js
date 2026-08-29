/** PR title for a card: "T-XXXX: <card title>". */
export function buildPrTitle({ task }) {
  return `${task.id}: ${task.title}`;
}

/**
 * Card sections that describe the change, as opposed to instructing the agent that made it
 * or recording board state about it. An allowlist rather than a denylist on purpose: card
 * bodies grow new instruction sections all the time (`## Reuse before you generate`,
 * `## The gates every prop in this room must clear`, `## Pipeline prerequisite`), and a
 * denylist would silently start pasting each new one.
 */
const DESCRIPTIVE_SECTION_RE = /^##\s+(context|story|acceptance)\b/i;

/** Splits a card body into `## `-delimited sections, keeping `###` subheadings with their parent. */
function splitSections(body) {
  const sections = [];
  let current = null;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      current = { heading: line, lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

/**
 * The descriptive part of a card body: its Context/Story/Acceptance sections, in the order
 * the card wrote them. Everything else -- `## Blocked` timestamps, `## Amendment` notes, and
 * the instruction sections aimed at the implementer -- is dropped, because a PR description
 * is read by a person deciding whether to merge, not by the agent that did the work.
 */
function summarizeCardBody(body) {
  return splitSections(body)
    .filter((s) => DESCRIPTIVE_SECTION_RE.test(s.heading))
    .map((s) => s.lines.join("\n").trim())
    .join("\n\n")
    .trim();
}

/**
 * PR body for a card: the card's own descriptive sections, the reviewer's verdict as a
 * headline, and the reviewer's raw notes folded into a `<details>` block -- nothing invented
 * beyond the card's own fields, and nothing dropped, only collapsed.
 *
 * This used to paste `task.body` verbatim with the notes inline, which on the Signal Tower
 * room cards produced 9.7k-16.3k character descriptions dominated by implementer
 * instructions, `## Blocked`/`## Amendment` bookkeeping, and multi-thousand-character
 * verdict prose written for the orchestrator's parser.
 */
export function buildPrBody({ task, verdict }) {
  const summary = summarizeCardBody(task?.body);
  const outcome = verdict?.verdict || "UNKNOWN";
  const notes = verdict?.notes || "(no notes recorded)";

  const sections = [`## ${task.id}: ${task.title}`];
  if (summary) sections.push(summary);
  sections.push(
    `## Reviewer verdict: ${outcome}`,
    [
      "<details>",
      `<summary>Full reviewer notes (${outcome})</summary>`,
      "",
      notes,
      "",
      "</details>"
    ].join("\n"),
    `_Card ${task.id} carries the full body, including its acceptance history._`
  );
  return sections.join("\n\n");
}
