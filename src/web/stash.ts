// The prompt stash (T3 Code's): a half-written prompt, with its images, parked
// to send later from any chat on this device. Browser storage is a few MB
// shared with drafts and settings, so an entry keeps its images only while
// they fit a budget (the rest are dropped and counted), and the stash keeps
// the newest twenty.
import type { ImageAttachment } from "../shared/protocol.js";
import { load, save } from "./storage.js";

export interface StashedImage extends ImageAttachment {
  width: number | null;
  height: number | null;
}

export interface StashEntry {
  id: string;
  text: string;
  images: StashedImage[];
  /** Images left out to stay inside the budget. */
  dropped: number;
  /** The chat it was stashed from. */
  from: string;
  at: number;
}

export const MAX_STASH = 20;
/** Base64 characters of images one entry may keep (about 1.1 MB of images). */
export const IMAGE_BUDGET = 1_500_000;
const KEY = "stash.v1";

let counter = 0;

/** Add a draft at the top; null when there is nothing to stash. */
export function stashDraft(entries: readonly StashEntry[], draft: { text: string; images: readonly StashedImage[]; from: string }, now = Date.now()): StashEntry[] | null {
  const text = draft.text.trim();
  if (!text && draft.images.length === 0) return null;
  const images: StashedImage[] = [];
  let used = 0;
  for (const image of draft.images) {
    if (used + image.data.length > IMAGE_BUDGET) continue;
    used += image.data.length;
    images.push({ mimeType: image.mimeType, data: image.data, width: image.width, height: image.height });
  }
  const entry: StashEntry = { id: `s${now.toString(36)}${(counter++).toString(36)}`, text: draft.text, images, dropped: draft.images.length - images.length, from: draft.from, at: now };
  return [entry, ...entries].slice(0, MAX_STASH);
}

/** Take an entry out: it goes back into a composer. */
export function takeFromStash(entries: readonly StashEntry[], id: string): { entries: StashEntry[]; entry: StashEntry | null } {
  const entry = entries.find((e) => e.id === id) ?? null;
  return { entries: entries.filter((e) => e.id !== id), entry };
}

export function loadStash(): StashEntry[] {
  const raw = load<unknown>(KEY, []);
  return Array.isArray(raw) ? raw.filter((e): e is StashEntry => typeof e?.id === "string" && typeof e.text === "string" && Array.isArray(e.images)).slice(0, MAX_STASH) : [];
}

/** False when the browser refused it (storage full): the caller keeps the draft. */
export function saveStash(entries: readonly StashEntry[]): boolean {
  save(KEY, entries.length > 0 ? entries : null);
  return entries.length === 0 || load<unknown[]>(KEY, []).length === entries.length;
}
