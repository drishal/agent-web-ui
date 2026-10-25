// What the file viewer can show besides a file's source: Markdown rendered as
// the page it describes. The extension decides the offer; the server decides the
// bytes, and only the project's own files ever reach here (file-view.ts).
export type PreviewKind = "markdown" | "html" | "image";

const MARKDOWN = new Set(["md", "markdown"]);
const HTML = new Set(["html", "htm"]);
/** The raster types the media route sniffs; SVG is source, since it can run script. */
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** The rendered view the viewer offers for `path`, or null for plain source. */
export function previewKind(path: string): PreviewKind | null {
  const dot = path.lastIndexOf(".");
  // A dotfile (".md") has no extension, and a name ending in a dot has none either.
  if (dot <= 0 || dot === path.length - 1) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  if (MARKDOWN.has(extension)) return "markdown";
  if (HTML.has(extension)) return "html";
  return IMAGE.has(extension) ? "image" : null;
}
