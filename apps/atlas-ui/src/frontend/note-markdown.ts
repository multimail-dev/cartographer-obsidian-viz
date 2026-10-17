import DOMPurify from "dompurify";
import { marked } from "marked";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function prepareWikilinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]\|\n]+?)(?:\|([^\]\n]+?))?\]\]/g, (match, target: string, label?: string) => {
    const normalizedTarget = target.trim();
    const normalizedLabel = (label ?? target).trim();
    if (!normalizedTarget) return match;
    return `<a href="[[${escapeHtml(normalizedTarget)}]]">${escapeHtml(normalizedLabel || normalizedTarget)}</a>`;
  });
}

function isAllowedUrl(value: string, image: boolean): boolean {
  // These anchors are intercepted by wikilinkHandler, never used for navigation.
  if (!image && /^\[\[[^\]\r\n]+\]\]$/.test(value)) return true;
  try {
    // Validate the browser-parsed URL after DOMPurify has decoded HTML entities.
    const protocol = new URL(value, document.baseURI).protocol;
    return protocol === "http:" || protocol === "https:" || (!image && protocol === "mailto:");
  } catch {
    return false;
  }
}

/** The only boundary for rendering untrusted vault Markdown into the live DOM. */
export function renderNoteMarkdown(markdown: string): DocumentFragment {
  const html = marked.parse(prepareWikilinks(markdown), {
    breaks: true, gfm: true, async: false,
  }) as string;
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "em", "del", "blockquote", "ul", "ol", "li", "pre", "code",
      "table", "thead", "tbody", "tr", "th", "td", "img",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "start", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  // Tighten DOMPurify's defaults (which permit data: images) to an explicit
  // protocol allowlist. Only remove attributes; never reparse sanitized HTML.
  fragment.querySelectorAll("[href], [src]").forEach((element) => {
    for (const attribute of ["href", "src"]) {
      const value = element.getAttribute(attribute);
      if (value !== null && !isAllowedUrl(value, attribute === "src")) {
        element.removeAttribute(attribute);
      }
    }
  });
  return fragment;
}
