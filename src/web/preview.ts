// What the file viewer can show besides a file's source: Markdown rendered as
// the page it describes. The extension decides the offer; the server decides the
// bytes, and only the project's own files ever reach here (file-view.ts).
export type PreviewKind = "markdown" | "html";

const MARKDOWN = new Set(["md", "markdown"]);
const HTML = new Set(["html", "htm"]);

/** The rendered view the viewer offers for `path`, or null for plain source. */
export function previewKind(path: string): PreviewKind | null {
  const dot = path.lastIndexOf(".");
  // A dotfile (".md") has no extension, and a name ending in a dot has none either.
  if (dot <= 0 || dot === path.length - 1) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  if (MARKDOWN.has(extension)) return "markdown";
  return HTML.has(extension) ? "html" : null;
}
