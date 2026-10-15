// render_html for harnesses without an extension API (Claude Code): the same
// tool as extensions/render-html.ts, served over MCP (JSON-RPC 2.0, one message
// per line on stdio), with no dependencies. awui starts it per chat through the
// harness's MCP config, with the chat's render endpoint in its environment:
//
//   AWUI_RENDER_URL    POST target, e.g. http://127.0.0.1:4783/api/render
//   AWUI_RENDER_TOKEN  the chat's render token, sent as X-Awui-Render-Token
//
// Without both it serves no tools. An MCP tool result carries only content,
// so the page's reference rides on its last line as `awui-html-render: {json}`;
// awui's adapter moves it into the tool's details (and off the text), and
// accepts it only from this tool.

import { createInterface } from "node:readline";

const URL_ENV = process.env.AWUI_RENDER_URL;
const TOKEN = process.env.AWUI_RENDER_TOKEN;
const MARKER = "awui-html-render:";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;
const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const THEME_VARS = "--bg --surface --surface-2 --border --text --text-2 --muted --accent --accent-hover --link --ok --danger --warn --info --orange --thinking --font-sans --font-mono";

const TOOL = {
  name: "render_html",
  description:
    "Show a finished HTML page (chart, table, diagram, mockup) inline in this chat, above your final text reply; call it before writing that reply. " +
    "Write one complete, self-contained document with inline <style> and <script> and no external <script src> for its logic (remote data urls over https are fine). " +
    "Style it from the reader's theme variables, already set on :root and matching the light or dark page around the frame: " +
    THEME_VARS +
    ". The body starts with var(--bg) and var(--text); set only the rest. Keep the page short enough to read at a glance; a height below the content height makes the rest scroll inside the frame. " +
    "The reader already sees the page, so the reply should not announce it or say where it is: add only what the page doesn't say.",
  inputSchema: {
    type: "object",
    required: ["html", "title", "height"],
    properties: {
      html: { type: "string", description: "The complete HTML document." },
      title: { type: "string", description: "Short name for the page." },
      height: { type: "number", description: `Frame height in CSS pixels, ${MIN_HEIGHT}-${MAX_HEIGHT}; ${DEFAULT_HEIGHT} is a good default. Shorter than the content and the rest scrolls.` },
    },
  },
};

const text = (value) => ({ type: "text", text: value });
const failure = (message) => ({ content: [text(message)], isError: true });

async function render(args) {
  const html = typeof args?.html === "string" ? args.html : "";
  if (html.trim() === "") return failure("html is empty: pass a complete HTML document");
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_HTML_BYTES) return failure(`html is ${(bytes / 1024).toFixed(0)} KB; the limit is ${MAX_HTML_BYTES / 1024} KB`);
  const title = typeof args.title === "string" && args.title.trim() !== "" ? args.title.trim() : "HTML";
  const height = Number.isFinite(args.height) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(args.height))) : DEFAULT_HEIGHT;
  let page;
  try {
    const response = await fetch(URL_ENV, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Awui-Render-Token": TOKEN },
      body: JSON.stringify({ html, title, height }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      return failure(`the chat's render endpoint refused the page (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
    }
    page = await response.json();
  } catch (error) {
    return failure(`could not reach the chat's render endpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ref = JSON.stringify({ id: page.id, title, height });
  return { content: [text(`Rendered "${title}" into the chat. The page is above; do not describe or restate it in your reply.\n${MARKER} ${ref}`)] };
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function handle(message) {
  const { id, method, params } = message;
  // A notification (no id) needs no answer.
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    return send({
      id,
      result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "awui", version: "1" } },
    });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: URL_ENV && TOKEN ? [TOOL] : [] } });
  if (method === "tools/call") {
    if (params?.name !== TOOL.name || !URL_ENV || !TOKEN) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
    return send({ id, result: await render(params.arguments ?? {}) });
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  void handle(message);
});
