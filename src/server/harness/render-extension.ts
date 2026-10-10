// The render_html extension (extensions/render-html.ts) that awui's Pi and
// omp children load with -e: it registers an agent tool which POSTs a
// self-contained HTML page to the chat's render endpoint and returns the
// page's id in the tool result's `details`, so the adapter can attach it to
// the tool card. Claude Code has no extension API; it gets the same tool from
// awui's MCP server instead. The extension activates only when the child was
// spawned with AWUI_RENDER_URL and AWUI_RENDER_TOKEN, so loading it anywhere
// else registers nothing.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RENDER_TOOL_NAME = "render_html";

let found: string | null | undefined;

/** The extension file, found by walking up from here (src/ in development, dist/ when built). */
export function renderHtmlExtension(): string | null {
  if (found !== undefined) return found;
  found = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", "render-html.ts");
    if (existsSync(file)) return (found = file);
    if (path.dirname(dir) === dir) return found;
  }
}

/** The CLI arguments that load it, or none when it is missing. */
export function renderHtmlExtensionArgs(): string[] {
  const file = renderHtmlExtension();
  return file ? ["-e", file] : [];
}

let foundEval: string | null | undefined;

/** The eval_python extension file (scratch-dir Python for the awui chat surface). */
export function evalPythonExtension(): string | null {
  if (foundEval !== undefined) return foundEval;
  foundEval = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", "eval-python.ts");
    if (existsSync(file)) return (foundEval = file);
    if (path.dirname(dir) === dir) return foundEval;
  }
}

/** The CLI arguments that load eval_python, or none when it is missing. */
export function evalPythonExtensionArgs(): string[] {
  const file = evalPythonExtension();
  return file ? ["-e", file] : [];
}
