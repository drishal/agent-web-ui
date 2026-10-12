// HTML pages agents publish into a chat (the render_html extension). Each is
// a self-contained document stored with its theme bootstrap injected,
// addressed by a random id, and shown to the browser from
// /api/chats/:id/html-render/:renderId. Pages live in a shadow folder under
// the state directory (one file per page), not in the session file: the
// harness's transcript is never edited, and a reload re-reads the session and
// re-arms the frame from the stored `details.htmlRender`.
//
// Who may see a page is the chat's own transcript, not a table here: a chat
// serves a page only when one of its tool items carries that page's id
// (Chat.ownsHtmlRender). Ids are 128 random bits that reach a transcript only
// through the render tool's result, so this holds across a restart, a resume,
// or a reopen, which a chat-id table kept in memory would not.
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HTML_RENDER_MAX_BYTES, type HtmlRenderRef } from "../shared/protocol.js";
import { clampHtmlRenderHeight, htmlRenderTitle, injectHtmlRenderBootstrap } from "../shared/html-render.js";

/** How many pages the in-memory cache holds; the rest are re-read from disk on request. */
const MAX_CACHED = 200;

export interface SavedRender extends HtmlRenderRef {
  /** The bytes the browser fetches; counted against the budget. */
  byteLength: number;
}

// Recently served pages, id → document, least recently used first.
const cache = new Map<string, string>();
const dirFor = (stateDir: string) => path.join(stateDir, "html-render");
const fileFor = (stateDir: string, id: string) => path.join(dirFor(stateDir), `${id}.html`);

/** A page id as the store issues them. */
export const isHtmlRenderId = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);

function remember(id: string, html: string): void {
  cache.delete(id);
  cache.set(id, html);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Store a page and return the reference a tool card carries. `title` and
 * `height` are sanitized; the document gets its theme bootstrap before it is
 * written, so the served bytes never change. Returns null when the document
 * is empty, over the byte cap, or has no usable height.
 */
export async function saveHtmlRender(stateDir: string, input: { html: string; title: unknown; height: unknown }): Promise<SavedRender | null> {
  const html = typeof input.html === "string" ? input.html : "";
  if (html.trim() === "") return null;
  const injected = injectHtmlRenderBootstrap(html);
  const bytes = Buffer.byteLength(injected, "utf8");
  if (bytes > HTML_RENDER_MAX_BYTES) return null;
  if (typeof input.height !== "number" || !Number.isFinite(input.height)) return null;
  const id = createHash("sha256").update(injected).update(randomBytes(8)).digest("hex").slice(0, 32);
  const ref: HtmlRenderRef = { id, title: htmlRenderTitle(input.title), height: clampHtmlRenderHeight(input.height) };
  await fs.mkdir(dirFor(stateDir), { recursive: true, mode: 0o700 });
  await fs.writeFile(fileFor(stateDir, id), injected, { mode: 0o600 });
  remember(id, injected);
  return { ...ref, byteLength: bytes };
}

/** The stored page, from memory or disk; null when the id is not one we wrote. Callers check ownership first. */
export async function readHtmlRender(stateDir: string, id: string): Promise<string | null> {
  if (!isHtmlRenderId(id)) return null;
  const held = cache.get(id);
  if (held !== undefined) {
    remember(id, held);
    return held;
  }
  const html = await fs.readFile(fileFor(stateDir, id), "utf8").catch(() => null);
  if (html !== null) remember(id, html);
  return html;
}
