// HTML pages agents publish into a chat (the render_html extension, or awui's
// MCP server for Claude Code). Each is a self-contained document stored with
// its theme bootstrap injected, addressed by a random id, and shown to the
// browser from /api/chats/:id/html-render/:renderId. Pages live in a shadow
// folder under the state directory (one file per page), not in the session
// file: the harness's transcript is never edited, and a reload re-reads the
// session and re-arms the frame from the stored `details.htmlRender`. An
// in-memory index bounds how many pages a process holds at once.
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  HTML_RENDER_MAX_BYTES,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  type HtmlRenderRef,
} from "../shared/protocol.js";
import { htmlRenderTitle, injectHtmlRenderBootstrap } from "../shared/html-render.js";

/** Largest page stored, matching the extension's own cap. */
const MAX_STORE_BYTES = HTML_RENDER_MAX_BYTES;
/** How many pages one process holds on disk before the oldest drop. */
const MAX_PAGES = 200;

interface StoredPage {
  /** The document, bootstrap injected, ready to serve. */
  html: string;
}

export interface SavedRender extends HtmlRenderRef {
  /** The bytes the browser fetches; counted against the budget. */
  byteLength: number;
}

// The pages one process serves, id → page, newest last. Pages stay on disk
// even past the in-memory cap; a request re-reads them, so eviction only
// costs a disk read, while the index that maps a chat to its pages stays.
const pages = new Map<string, StoredPage>();
// The chat each page belongs to, so /html-render/:id serves a page only to
// the chat that asked. In memory: a page's worth is its live frame, so this
// need not survive a restart (the items still carry the reference; the bytes
// re-arm on the same id, which stays on disk).
const owners = new Map<string, string>();
const dirFor = (stateDir: string) => path.join(stateDir, "html-render");
const fileFor = (stateDir: string, id: string) => path.join(dirFor(stateDir), `${id}.html`);

const isId = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);

/**
 * Store a page and return the reference a tool card carries. `title` and
 * `height` are sanitized; the document gets its theme bootstrap before it is
 * written, so the served bytes never change. Returns null when the document
 * is empty or over the byte cap.
 */
export async function saveHtmlRender(stateDir: string, chatId: string, input: { html: string; title: unknown; height: unknown }): Promise<SavedRender | null> {
  const html = typeof input.html === "string" ? input.html : "";
  if (html.trim() === "") return null;
  const injected = injectHtmlRenderBootstrap(html);
  const bytes = Buffer.byteLength(injected, "utf8");
  if (bytes > MAX_STORE_BYTES) return null;
  const id = createHash("sha256").update(injected).update(randomBytes(8)).digest("hex").slice(0, 32);
  const title = htmlRenderTitle(input.title);
  const height = Number.isFinite(input.height as number)
    ? Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(input.height as number)))
    : undefined;
  if (height === undefined) return null;
  const ref: HtmlRenderRef = { id, title, height };
  const dir = dirFor(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(fileFor(stateDir, id), injected, { mode: 0o600 });
  // Newest last; evict the oldest in-memory entries past the cap.
  pages.delete(id);
  pages.set(id, { html: injected });
  owners.set(id, chatId);
  while (pages.size > MAX_PAGES) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) break;
    pages.delete(oldest);
  }
  return { ...ref, byteLength: bytes };
}

/** The chat that owns a page, or undefined when this process did not store it. */
export function htmlRenderOwner(id: string): string | undefined {
  return owners.get(id);
}

/** The stored page, but only for the chat that owns it; null otherwise. */
export async function readHtmlRenderForChat(stateDir: string, chatId: string, id: string): Promise<string | null> {
  if (htmlRenderOwner(id) !== chatId) return null;
  return readHtmlRender(stateDir, id);
}

/** The stored page, from memory or disk; null when the id is not one we wrote. */
export async function readHtmlRender(stateDir: string, id: string): Promise<string | null> {
  if (!isId(id)) return null;
  const held = pages.get(id);
  if (held) {
    pages.delete(id);
    pages.set(id, held);
    return held.html;
  }
  const html = await fs.readFile(fileFor(stateDir, id), "utf8").catch(() => null);
  if (html === null) return null;
  pages.set(id, { html });
  return html;
}

/** Validate a tool result's `details.htmlRender` into a reference, or undefined. */
export function readHtmlRenderDetails(value: unknown): HtmlRenderRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const d = value as Record<string, unknown>;
  if (!isId(typeof d.id === "string" ? d.id : "")) return undefined;
  const title = htmlRenderTitle(d.title);
  const height = Number.isFinite(d.height as number)
    ? Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(d.height as number)))
    : undefined;
  if (height === undefined) return undefined;
  const ref: HtmlRenderRef = { id: d.id as string, title, height };
  const heights = typeof d.heights !== "undefined" ? d.heights : undefined;
  if (Array.isArray(heights)) {
    const read = heights.filter(
      (entry): entry is readonly [number, number] =>
        Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]),
    );
    if (read.length === heights.length && read.length > 0) {
      ref.heights = read.sort((a, b) => a[0] - b[0]).map(([w, h]) => [w, Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(h)))] as const);
    }
  }
  return ref;
}

export const __testing = { pages, MAX_PAGES };
