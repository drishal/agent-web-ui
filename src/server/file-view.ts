// A project file, read for the file viewer. Confined to what the project
// lists (project-files.ts: what git tracks plus untracked files it does not
// ignore, else its walk), so a gitignored .env or a build folder stays out;
// resolved by realpath, so a link out of the project is refused; read-only;
// and bounded: the first 512 KB, cut at a line, and no text for a binary file.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileView } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { knownFile } from "./project-files.js";
import { isWithin } from "./workspaces.js";

export const VIEW_BYTES = 512 * 1024;
/** A NUL in the first stretch: a binary file. */
const SNIFF_BYTES = 8192;

/** `input` in the project at `root` (a real path): relative to it, or absolute inside it. */
export async function viewFile(root: string, input: string): Promise<FileView> {
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
