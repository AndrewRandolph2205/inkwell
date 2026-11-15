import sanitizeHtml from "sanitize-html";
import mammoth from "mammoth";
import { marked } from "marked";
import { extname, basename } from "node:path";

/**
 * Whitelist matches what the editor (TipTap StarterKit + Underline) can represent,
 * so stored HTML always round-trips through the editor without loss.
 */
const ALLOWED: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "h1", "h2", "h3", "strong", "b", "em", "i", "u", "s",
    "ul", "ol", "li", "blockquote", "code", "pre", "hr",
  ],
  allowedAttributes: { ol: ["start"] },
  // Collapse heading levels the editor does not offer into the nearest one it does.
  transformTags: { h4: "h3", h5: "h3", h6: "h3" },
};

export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, ALLOWED);
}

export const SUPPORTED_IMPORT_TYPES = [".txt", ".md", ".docx"] as const;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export class ImportError extends Error {}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Convert an uploaded file into sanitized editor HTML plus a suggested title. */
export async function fileToDocument(
  originalName: string,
  buffer: Buffer,
): Promise<{ title: string; content: string }> {
  const ext = extname(originalName).toLowerCase();
  const title = basename(originalName, extname(originalName)).trim().slice(0, 200) || "Imported document";
  let html: string;
  switch (ext) {
    case ".txt":
      html = textToHtml(buffer.toString("utf8"));
      break;
    case ".md":
      html = await marked.parse(buffer.toString("utf8"));
      break;
    case ".docx":
      try {
        html = (await mammoth.convertToHtml({ buffer })).value;
      } catch {
        throw new ImportError("That .docx file could not be read. Is it a valid Word document?");
      }
      break;
    default:
      throw new ImportError(
        `Unsupported file type "${ext || "none"}". Supported: ${SUPPORTED_IMPORT_TYPES.join(", ")}.`,
      );
  }
  return { title, content: sanitizeContent(html) };
}
