function extractAssistantText(event) {
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

/** Renders one parsed run event as a single console-pane log line. */
export function formatRunEvent(event, phase) {
  const prefix = phase ? `[${phase}] ` : "";
  if (!event || typeof event.type !== "string") {
    return `${prefix}(unrecognized event)`;
  }

  switch (event.type) {
    case "system":
      return `${prefix}system: ${event.subtype ?? "init"}`;
    case "assistant": {
      const text = extractAssistantText(event);
      return text ? `${prefix}${text}` : `${prefix}assistant message`;
    }
    case "result":
      return `${prefix}result: ${event.result ?? event.subtype ?? "done"}`;
    case "error":
      return `${prefix}error: ${event.error ?? "unknown error"}`;
    default:
      return `${prefix}${event.type}`;
  }
}
