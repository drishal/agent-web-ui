// The render tool's names and the normalization of its result into the
// reference a tool card carries. Three call shapes register it: the extension
// (Pi/omp) names it plain `render_html`; the MCP server (Claude) serves it as
// `awui.render_html`; and the omp session's built-in `xd://...` device (what
// this agent sees as `write xd://render_html`) runs it as a WRITE with that
// device path in its args. Its result's `details.htmlRender` holds
// { id, title, height }; only one of those exact shapes may carry it, so a
// result that imitates the shape without going through the render tool does
// not publish a page. Live (chat.ts) and history (agent-events.ts) both read
// the reference through here so they agree.
import { HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MIN_HEIGHT, type HtmlRenderRef } from "../../shared/protocol.js";
import { htmlRenderTitle } from "../../shared/html-render.js";
import { RENDER_TOOL_NAME } from "./render-extension.js";

/** The MCP server Claude Code is given: its tools name themselves `awui.render_html`. */
export const HTML_RENDER_MCP_SERVER = "awui";
/** The MCP tool Claude calls; Pi and omp's extension registers plain `render_html`. */
export const HTML_RENDER_MCP_TOOL = `${HTML_RENDER_MCP_SERVER}.${RENDER_TOOL_NAME}`;

/** The omp chat's built-in `xd://render_html` device arrives as a write with that path in its args. */
const XD_DEVICE_PREFIX = "xd://";
const XD_RENDER = `${XD_DEVICE_PREFIX}${RENDER_TOOL_NAME}`;

function isXdRenderWrite(toolName: string, args: unknown): boolean {
  if (toolName !== "write" || !isArgsObj(args)) return false;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" && path === XD_RENDER;
}
function isArgsObj(a: unknown): a is Record<string, unknown> {
  return typeof a === "object" && a !== null && !Array.isArray(a);
}

/** The reference a tool result's `details.htmlRender` holds, or undefined when it is not one. */
export function htmlRenderFromDetails(toolName: string, args: unknown, details: unknown): HtmlRenderRef | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const candidate = (details as Record<string, unknown>).htmlRender;
  const ref = readHtmlRenderRef(candidate);
  if (ref === undefined) return undefined;
  // A tool's own result can imitate the shape; only the render tool in one of its three
  // shapes (extension, MCP, the xd:// device rewrite) may carry it.
  return toolName === RENDER_TOOL_NAME || toolName === HTML_RENDER_MCP_TOOL || isXdRenderWrite(toolName, args) ? ref : undefined;
}

function readHtmlRenderRef(value: unknown): HtmlRenderRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || !/^[0-9a-f]{32}$/.test(d.id)) return undefined;
  if (typeof d.height !== "number" || !Number.isFinite(d.height)) return undefined;
  return {
    id: d.id,
    title: htmlRenderTitle(d.title),
    height: Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(d.height))),
  };
}
