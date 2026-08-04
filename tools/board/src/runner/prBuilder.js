/** PR title for a card: "T-XXXX: <card title>". */
export function buildPrTitle({ task }) {
  return `${task.id}: ${task.title}`;
}

/**
 * PR body summarizing the card's own story/acceptance (its body verbatim),
 * the reviewer's PASS verdict, and the test/lint notes the reviewer
 * captured in that verdict -- nothing invented beyond the card's own fields.
 */
export function buildPrBody({ task, verdict }) {
  const sections = [
    `## ${task.id}: ${task.title}`,
    task.body.trim(),
    `## Reviewer verdict: PASS`,
    verdict.notes || "(no notes recorded)"
  ];
  return sections.join("\n\n");
}
