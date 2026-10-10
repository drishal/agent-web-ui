// The render tool's names and the normalization of its result into the
// reference a tool card carries. Both extension (Pi/omp) and MCP (Claude)
// register the same tool; the extension calls it plain `render_html`, the MCP
// server serves it as `awui.render_html`. Its result's `details.htmlRender`
// holds { id, title, height }; only one of those exact tool names may carry
// it, so a result that imitates the shape without being the render tool does
// not publish a page. Live (chat.ts) and history (agent-events.ts) both read
// the reference through here so they agree.
import { HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MIN_HEIGHT, type HtmlRenderRef } from "../../shared/protocol.js";
import { htmlRenderTitle } from "../../shared/html-render.js";
import { RENDER_TOOL_NAME } from "./render-extension.js";

/** The MCP server Claude Code is given: its tools name themselves `awui.render_html`. */
export const HTML_RENDER_MCP_SERVER = "awui";
/** The MCP tool Claude calls; Pi and omp's extension registers plain `render_html`. */
export const HTML_RENDER_MCP_TOOL = `${HTML_RENDER_MCP_SERVER}.${RENDER_TOOL_NAME}`;

/** The reference a tool result's `details.htmlRender` holds, or undefined when it is not one. */
export function htmlRenderFromDetails(toolName: string, details: unknown): HtmlRenderRef | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const candidate = (details as Record<string, unknown>).htmlRender;
  const ref = readHtmlRenderRef(candidate);
  // A tool's own result can imitate the shape; only the render tool itself may carry it.
  return ref !== undefined && (toolName === RENDER_TOOL_NAME || toolName === HTML_RENDER_MCP_TOOL) ? ref : undefined;
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
