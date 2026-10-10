// render_html: publish a finished, self-contained HTML page (a chart, table,
// diagram, mockup) into the chat, where awui shows it in a sandboxed frame
// above the final reply. awui loads this into every Pi and omp child with -e
// (it speaks only the extension API both share, and imports nothing) and
// points it at its render endpoint with two environment variables:
//
//   AWUI_RENDER_URL    POST target, e.g. http://127.0.0.1:4783/api/render/<chat>
//   AWUI_RENDER_TOKEN  the chat's render token, sent as X-Awui-Render-Token
//
// Without both it registers nothing, so a stray copy elsewhere stays inert.
// A page is a single HTML document with inline <style> and <script>, remote
// http(s) resources loading as-is. The endpoint stores it and answers
// { id, url }; the tool result's `details` carries both so awui's adapter can
// attach the page to this call's tool card.

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
  isError?: boolean;
}

interface RenderPage {
  id: string;
  url: string;
}

interface Api {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: { html: string; title: string; height: number }): Promise<ToolResult>;
  }): void;
}

// Loaded twice (from a project's extensions folder and again with -e), it registers once.
const LOADED = Symbol.for("awui-render-html.loaded");

const text = (value: string): ToolContent => ({ type: "text", text: value });

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;
const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const THEME_VARS = "--bg --surface --surface-2 --border --text --text-2 --muted --accent --accent-hover --link --ok --danger --warn --info --orange --thinking --font-sans --font-mono";

export default function renderHtml(pi: Api): void {
  const url = process.env.AWUI_RENDER_URL;
  const token = process.env.AWUI_RENDER_TOKEN;
  if (!url || !token) return;
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[LOADED]) return;
  registry[LOADED] = true;

  pi.registerTool({
    name: "render_html",
    label: "Render HTML",
    description:
      "Show a finished HTML page (chart, table, diagram, mockup) inline in this chat, above your final text reply; call it before writing that reply. " +
      "Write one complete, self-contained document with inline <style> and <script> and no external <script src> for its logic (remote data urls over https are fine). " +
      "Style it from the reader's theme variables, already set on :root and matching the light or dark page around the frame: " +
      THEME_VARS +
      ". The body starts with var(--bg) and var(--text); set only the rest. Keep the page short enough to read at a glance; a height below the content height makes the rest scroll inside the frame. " +
      "The reader already sees the page, so the reply should not announce it or say where it is: add only what the page doesn't say.",
    parameters: {
      type: "object",
      required: ["html", "title", "height"],
      properties: {
        html: { type: "string", description: "The complete HTML document." },
        title: { type: "string", description: "Short name for the page." },
        height: {
          type: "number",
          description: `Frame height in CSS pixels, ${MIN_HEIGHT}-${MAX_HEIGHT}; ${DEFAULT_HEIGHT} is a good default. Shorter than the content and the rest scrolls.`,
        },
      },
    },
    async execute(_toolCallId, params) {
      const html = typeof params.html === "string" ? params.html : "";
      if (html.trim() === "") return { content: [text("html is empty: pass a complete HTML document")], details: {}, isError: true };
      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > MAX_HTML_BYTES)
        return { content: [text(`html is ${(bytes / 1024).toFixed(0)} KB; the limit is ${MAX_HTML_BYTES / 1024} KB`)], details: {}, isError: true };
      const title = typeof params.title === "string" && params.title.trim() !== "" ? params.title.trim() : "HTML";
      const height = Number.isFinite(params.height) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(params.height))) : DEFAULT_HEIGHT;
      let page: RenderPage;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Awui-Render-Token": token },
          body: JSON.stringify({ html, title, height }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          return { content: [text(`the chat's render endpoint refused the page (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)], details: {}, isError: true };
        }
        page = (await response.json()) as RenderPage;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { content: [text(`could not reach the chat's render endpoint: ${reason}`)], details: {}, isError: true };
      }
      return {
        content: [text(`Rendered "${title}" into the chat. The page is above; do not describe or restate it in your reply.`)],
        details: { htmlRender: { id: page.id, title, height }, url: page.url },
      };
    },
  });
}
