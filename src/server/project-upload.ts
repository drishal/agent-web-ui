// Uploading a file into a project: the one write this app makes inside a
// workspace. New files only (exclusive create, so nothing is clobbered and there
// is no check-then-write race), named by its base name so a path cannot climb
// out, bounded by the route's body limit, and kept inside the project's real path.
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ChatError } from "./chats/chat.js";
import { isWithin } from "./workspaces.js";

export const UPLOAD_NAME_CHARS = 120;

export async function writeProjectFile(root: string, name: string, bytes: Buffer): Promise<{ path: string; bytes: number }> {
  const base = path.basename(name).trim();
  if (!base || base === "." || base === ".." || base.includes("\0") || base.length > UPLOAD_NAME_CHARS) {
    throw new ChatError(400, "bad_name", "Name the file with a plain file name");
  }
  let real: string;
  try {
    real = await fs.realpath(root);
  } catch {
    throw new ChatError(404, "missing_project", "That project folder is gone");
  }
  const dest = path.join(real, base);
  if (!isWithin(real, dest)) throw new ChatError(403, "outside_project", "That name points out of the project");
  let handle: FileHandle;
  try {
    handle = await fs.open(dest, "wx", 0o644);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new ChatError(409, "file_exists", `${base} is already there`);
    throw new ChatError(422, "write_failed", error instanceof Error ? error.message : String(error));
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return { path: base, bytes: bytes.length };
}
