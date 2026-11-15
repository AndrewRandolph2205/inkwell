import TurndownService from "turndown";

const td = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  strongDelimiter: "**",
  hr: "---",
});

// Markdown has no underline; keep it as inline HTML, which CommonMark renderers pass through.
td.keep(["u"]);

td.addRule("strikethrough", {
  filter: ["s", "del"],
  replacement: (content) => `~~${content}~~`,
});

// Turndown's default list items use "-   " (three spaces). Use the conventional single space.
td.addRule("listItem", {
  filter: "li",
  replacement(content, node, options) {
    const parent = node.parentNode as HTMLElement;
    let prefix = `${options.bulletListMarker} `;
    if (parent.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? 1);
      prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
    }
    // Indent continuation lines (nested lists, extra paragraphs) under the marker, but leave
    // blank lines empty rather than filling them with trailing spaces.
    const body = content
      .replace(/^\n+/, "")
      .replace(/\n+$/, "")
      .replace(/\n(?=[^\n])/g, `\n${" ".repeat(prefix.length)}`);
    return prefix + body + (node.nextSibling ? "\n" : "");
  },
});

/** Convert stored (sanitized) editor HTML into a Markdown file, with the title as a heading. */
export function toMarkdown(title: string, html: string): string {
  const body = td.turndown(html || "").trim();
  const startsWithTitle = body.startsWith(`# ${title}`);
  return `${startsWithTitle ? "" : `# ${title}\n\n`}${body}\n`;
}

/** A filesystem-safe download name, e.g. "Q3 plan / draft" → "Q3-plan-draft.md". */
export function exportFilename(title: string, ext: string): string {
  const base = title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
  return `${base}.${ext}`;
}
