// A project file, read for the file viewer. Confined to what the project
// lists (project-files.ts: what git tracks plus untracked files it does not
// ignore, else its walk), so a gitignored .env or a build folder stays out;
// resolved by realpath, so a link out of the project is refused; read-only;
// and bounded: the first 512 KB, cut at a line, and no text for a binary file.
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import type { FileView } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { knownFile } from "./project-files.js";
import { isWithin } from "./workspaces.js";

export const VIEW_BYTES = 512 * 1024;
/** A NUL in the first stretch: a binary file. */
const SNIFF_BYTES = 8192;

/**
 * A listed project file, as a real path inside the project: the one gate both
 * readers (the text view and the image bytes) pass through.
 */
async function listed(root: string, input: string): Promise<{ real: string; stat: Stats; shown: string }> {
  if (input.includes("\0")) throw new ChatError(400, "bad_path", "Invalid path");
  const absolute = path.resolve(root, input);
  const rel = path.relative(root, absolute);
  if (!rel || !isWithin(root, absolute)) throw new ChatError(403, "outside_project", "That file is outside the project");
  const shown = rel.split(path.sep).join("/");
  if (!(await knownFile(root, rel))) throw new ChatError(404, "not_listed", "Only the project's own files open here: what git tracks, or does not ignore");
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new ChatError(404, "missing_file", "That file no longer exists");
  }
  if (!isWithin(root, real)) throw new ChatError(403, "outside_project", "That file links out of the project");
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new ChatError(400, "not_file", "That is not a file");
  return { real, stat, shown };
}

/** Images the browser may show from this origin; SVG is absent on purpose (it can run script). */
const MEDIA: Array<{ mimeType: string; test: (head: Buffer) => boolean }> = [
  { mimeType: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/gif", test: (b) => b.subarray(0, 4).toString("ascii") === "GIF8" },
  { mimeType: "image/webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

export const MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * An image's bytes from a listed project file, typed by its magic bytes rather
 * than its name, so a .png that is really a page or a script is refused.
 */
export async function readMedia(root: string, input: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const { real, stat } = await listed(root, input);
  if (stat.size > MEDIA_BYTES) throw new ChatError(413, "too_large", "That image is larger than 20 MB");
  const handle = await fs.open(real, "r");
  let head: Buffer;
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const kind = MEDIA.find((m) => m.test(head));
  if (!kind) throw new ChatError(415, "not_an_image", "Only PNG, JPEG, GIF, and WebP images preview here");
  return { bytes: await fs.readFile(real), mimeType: kind.mimeType };
}

/** `input` in the project at `root` (a real path): relative to it, or absolute inside it. */
export async function viewFile(root: string, input: string): Promise<FileView> {
  const { real, stat, shown } = await listed(root, input);
  const handle = await fs.open(real, "r");
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, VIEW_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const binary = bytes.subarray(0, SNIFF_BYTES).includes(0);
  const truncated = stat.size > bytes.length;
  let text = binary ? null : bytes.toString("utf8");
  // A cut file ends at its last whole line, not in the middle of one (or of a character).
  if (text !== null && truncated) text = text.slice(0, Math.max(0, text.lastIndexOf("\n") + 1));
  const lines = text === null ? 0 : text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return { path: shown, size: stat.size, text, binary, truncated, lines };
}
