const TEXT_MAX_LENGTH = 500;
const SUMMARY_MAX_LENGTH = 160;

function truncate(text, max) {
  if (typeof text !== "string") {
    return "";
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Renders a tool_use content block as a short, tool-specific one-liner. */
function summarizeToolUse(block) {
  const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
  const input = block.input && typeof block.input === "object" ? block.input : {};

  switch (name) {
    case "Bash": {
      const command = typeof input.command === "string" ? input.command.split("\n")[0] : "";
      return command ? `${name}: ${truncate(command, SUMMARY_MAX_LENGTH)}` : name;
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const path = typeof input.file_path === "string" ? input.file_path : "";
      return path ? `${name} ${truncate(path, SUMMARY_MAX_LENGTH)}` : name;
    }
    case "Grep":
    case "Glob": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      return pattern ? `${name}: ${truncate(pattern, SUMMARY_MAX_LENGTH)}` : name;
    }
    default: {
      const [firstKey] = Object.keys(input);
      const value = firstKey === undefined ? undefined : input[firstKey];
      const summary = typeof value === "string" ? value : "";
      return summary ? `${name}: ${truncate(summary, SUMMARY_MAX_LENGTH)}` : name;
    }
  }
}

/** Pulls the text out of a tool_result block's `content`, which is either a raw string or content blocks. */
function toolResultText(block) {
  if (typeof block.content === "string") {
    return block.content;
  }
  if (Array.isArray(block.content)) {
    return block.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/** Renders a tool_result content block as a compact success/error summary, using the tool name if known. */
function summarizeToolResult(block, toolName) {
  const label = toolName || "tool";
  const text = toolResultText(block).trim();

  if (block.is_error) {
    const firstLine = text.split("\n")[0] || "unknown error";
    return `✗ ${label} error: ${truncate(firstLine, SUMMARY_MAX_LENGTH)}`;
  }
  if (text.length === 0) {
    return `✓ ${label} done`;
  }
  const lines = text.split("\n");
  if (lines.length === 1 && text.length <= SUMMARY_MAX_LENGTH) {
    return `✓ ${label}: ${text}`;
  }
  return `✓ ${label} result (${lines.length} line${lines.length === 1 ? "" : "s"})`;
}

/** Extracts renderable lines from an assistant event's content blocks: joined text, then one line per tool_use. */
function assistantLines(event, prefix, toolNamesById) {
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const lines = [];

  const text = content
    .filter((block) => block && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
    .map((block) => block.text.trim())
    .join(" ");
  if (text.length > 0) {
    lines.push(`${prefix}${truncate(text, TEXT_MAX_LENGTH)}`);
  }

  for (const block of content) {
    if (block && block.type === "tool_use") {
      if (typeof block.id === "string" && toolNamesById) {
        toolNamesById.set(block.id, typeof block.name === "string" ? block.name : "tool");
      }
      lines.push(`${prefix}→ ${summarizeToolUse(block)}`);
    }
  }

  return lines;
}

/** Extracts renderable lines from a user event's content blocks: one line per tool_result. */
function toolResultLines(event, prefix, toolNamesById) {
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const lines = [];
  for (const block of content) {
    if (block && block.type === "tool_result") {
      const toolName = toolNamesById ? toolNamesById.get(block.tool_use_id) : undefined;
      lines.push(`${prefix}${summarizeToolResult(block, toolName)}`);
    }
  }
  return lines;
}

/**
 * Renders one parsed run event as zero or more console-pane log lines.
 *
 * `context.toolNamesById` is an optional Map, shared across a run's events by the
 * caller, used to label a later tool_result with the name of the tool_use that
 * produced it (stream-json only carries the id on the result, not the name).
 *
 * Envelope events that carry no useful content for a human watching the run --
 * system/init notices, unrecognized event types, and assistant/user messages
 * with no text/tool_use/tool_result blocks -- are omitted (empty array) rather
 * than rendered as a bare label.
 */
export function formatRunEvent(event, phase, context = {}) {
  const prefix = phase ? `[${phase}] ` : "";
  if (!event || typeof event.type !== "string") {
    return [];
  }

  switch (event.type) {
    case "assistant":
      return assistantLines(event, prefix, context.toolNamesById);
    case "user":
      return toolResultLines(event, prefix, context.toolNamesById);
    case "result":
      return [`${prefix}result: ${event.result ?? event.subtype ?? "done"}`];
    case "error":
      return [`${prefix}error: ${event.error ?? "unknown error"}`];
    default:
      return [];
  }
}
