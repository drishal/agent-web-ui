// Images the transcript shows under a prompt. Items carry only an id (a hash
// of the bytes) and the browser fetches /api/images/<id>, so a snapshot stays
// small however many screenshots a chat holds. In memory, least recently used
// out first past the budget; a reload re-reads the session file and puts
// them back.
import { createHash } from "node:crypto";
import type { ImageRef } from "../shared/protocol.js";

const BUDGET_BYTES = 192 * 1024 * 1024;
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface Stored {
  mimeType: string;
  bytes: Buffer;
}

const store = new Map<string, Stored>();
let used = 0;

/** Keep an image (base64), returning the reference an item carries. */
export function rememberImage(mimeType: string, base64: string): ImageRef | null {
  // Raster only: an SVG served from this origin could run script.
  if (!base64 || !RASTER.has(mimeType)) return null;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return null;
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const existing = store.get(id);
  store.delete(id);
  if (existing) {
    store.set(id, existing);
    return { id, mimeType };
  }
  store.set(id, { mimeType, bytes });
  used += bytes.length;
  for (const [key, value] of store) {
    if (used <= BUDGET_BYTES || key === id) break;
    store.delete(key);
    used -= value.bytes.length;
  }
  return { id, mimeType };
}

export function storedImage(id: string): Stored | null {
  const found = store.get(id);
  if (!found) return null;
  store.delete(id);
  store.set(id, found);
  return found;
}

/** Image blocks in Pi-family content (`{type:"image", data, mimeType}`) as references. */
export function imageRefs(content: unknown): ImageRef[] {
  if (!Array.isArray(content)) return [];
  const out: ImageRef[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "image" || typeof b.data !== "string" || typeof b.mimeType !== "string") continue;
    const ref = rememberImage(b.mimeType, b.data);
    if (ref) out.push(ref);
  }
  return out;
}
