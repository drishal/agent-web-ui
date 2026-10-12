// Pasted composer blobs parked as files under /tmp so a huge paste does not
// pin the prompt field. One directory per chat; ids are random. Nothing here
// names a user path to the browser beyond the file the server itself issued.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_PASTE_BYTES, type PasteAttachment } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";

const ROOT = path.join(tmpdir(), "awui-pastes");
const ID = /^[A-Za-z0-9_-]{8,40}$/;

/** Store one pasted blob for a chat, returning its attachment handle. */
export async function storePaste(chatId: string, text: string): Promise<PasteAttachment> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PASTE_BYTES) throw new ChatError(413, "paste_too_big", "That paste is larger than the 1 MiB file limit");
  const dir = path.join(ROOT, chatId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(9).toString("base64url");
  const file = path.join(dir, `${id}.txt`);
  await writeFile(file, text, { mode: 0o600 });
  return { id, path: file, bytes, lines: text.split("\n").length };
}

/** Resolve a client-supplied paste id back to its real file, confined to the chat's paste dir. */
export async function resolvePaste(chatId: string, id: string): Promise<PasteAttachment> {
  if (!ID.test(id)) throw new ChatError(400, "bad_paste", "Unknown attachment");
  const dir = path.join(ROOT, chatId);
  const file = path.join(dir, `${id}.txt`);
  const real = await realpath(file).catch(() => null);
  if (!real || !real.startsWith(dir + path.sep)) throw new ChatError(404, "paste_gone", "That attachment is no longer on disk");
  const text = await readFile(real, "utf8");
  return { id, path: real, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length };
}
