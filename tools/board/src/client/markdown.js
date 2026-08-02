const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const CHECKLIST_RE = /^-\s+\[( |x|X)\]\s+(.*)$/;
const BULLET_RE = /^-\s+(.*)$/;

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(body) {
  const lines = (body ?? "").split(/\r?\n/);
  const html = [];
  let listOpen = false;

  function closeList() {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = HEADING_RE.exec(line);
    const checklist = CHECKLIST_RE.exec(line);
    const bullet = BULLET_RE.exec(line);

    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
    } else if (checklist) {
      if (!listOpen) {
        html.push('<ul class="checklist">');
        listOpen = true;
      }
      const checked = checklist[1].toLowerCase() === "x";
      html.push(
        `<li><input type="checkbox" disabled${checked ? " checked" : ""} /> ${escapeHtml(checklist[2])}</li>`
      );
    } else if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(bullet[1])}</li>`);
    } else if (line.length === 0) {
      closeList();
    } else {
      closeList();
      html.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  closeList();
  return html.join("\n");
}
