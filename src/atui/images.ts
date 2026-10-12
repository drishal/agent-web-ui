// Images in atui, apart from the drawing: which graphics protocol to draw a
// prompt's images with (kitty's, which Ghostty speaks too, sixel, or half
// blocks), and what a paste holds when it is image files rather than text
// (a file dropped on the terminal arrives as its path, or a file:// URI).
// Attachments are checked by their bytes, the way the server checks them.
// The clipboard is read with OpenTUI's own reader where its build has one,
// else wl-paste (Wayland) or xclip (X11).
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { MAX_IMAGE_BYTES, MAX_IMAGES, type ImageAttachment, type ImageMimeType } from "../shared/protocol.js";
import { sniffImage } from "../server/images.js";

export type ImageMode = "auto" | "kitty" | "sixel" | "blocks" | "off";

const MODES: readonly ImageMode[] = ["auto", "kitty", "sixel", "blocks", "off"];

/** `--images`, else $ATUI_IMAGES, as a mode; null when neither names one. */
export function imageModeFrom(flag: string | undefined, env: Record<string, string | undefined>): ImageMode | null {
  const v = (flag ?? env.ATUI_IMAGES ?? "").trim().toLowerCase();
  return (MODES as readonly string[]).includes(v) ? (v as ImageMode) : null;
}

/**
 * The protocol a prompt's image is drawn with. An explicit mode wins. Else
 * OpenTUI's own detection ("auto": it asks the terminal), except that a
 * terminal which says it is kitty or Ghostty gets kitty's protocol even if
 * the query went unanswered; inside tmux, where graphics need passthrough,
 * half blocks unless asked.
 */
export function imageProtocol(mode: ImageMode | null, env: Record<string, string | undefined>): Exclude<ImageMode, "off"> | null {
  if (mode === "off") return null;
  if (mode && mode !== "auto") return mode;
  if (env.TMUX) return "blocks";
  const term = `${env.TERM ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
  if (/kitty|ghostty/.test(term) || env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR) return "kitty";
  return "auto";
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * The image files a paste names, when that is all it is: one path per line
 * or separated by spaces (as terminals paste dropped files), quoted or not,
 * `file://` URIs, `~/`. Null when any part is not an image path, so ordinary
 * text pastes stay text.
 */
export function imagePathsFromPaste(text: string, cwd: string, home = homedir()): string[] | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 8192) return null;
  // Quoted paths keep their spaces; unquoted ones are split on whitespace (backslash-escaped spaces kept).
  const parts = trimmed.match(/'[^']+'|"[^"]+"|(?:\\ |\S)+/g) ?? [];
  const out: string[] = [];
  for (const raw of parts) {
    let p = raw.replace(/^(['"])(.*)\1$/, "$2").replace(/\\ /g, " ");
    if (p.startsWith("file://")) {
      try {
        p = decodeURIComponent(new URL(p).pathname);
      } catch {
        return null;
      }
    }
    if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
    if (!IMAGE_FILE.test(p)) return null;
    out.push(path.resolve(cwd, p));
  }
  return out.length > 0 ? out.slice(0, MAX_IMAGES) : null;
}

/** A pending image as the composer holds it: what is sent, and the bytes its thumbnail is drawn from. */
export interface PendingImage extends ImageAttachment {
  bytes: Uint8Array;
}

/** Bytes as an attachment, when they are an image the server takes and small enough; else why not. */
export function attachmentFrom(bytes: Uint8Array): PendingImage | string {
  if (bytes.byteLength > MAX_IMAGE_BYTES) return `That image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`;
  const data = Buffer.from(bytes).toString("base64");
  const mimeType: ImageMimeType | null = sniffImage(data);
  if (!mimeType) return "That is not a PNG, JPEG, GIF, or WebP image";
  return { mimeType, data, bytes };
}

/** An image file as an attachment, or why it cannot be one. */
export async function attachmentFromFile(file: string): Promise<PendingImage | string> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return `${path.basename(file)} is not a file`;
    if (info.size > MAX_IMAGE_BYTES) return `${path.basename(file)} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`;
    return attachmentFrom(new Uint8Array(await readFile(file)));
  } catch {
    return `Cannot read ${path.basename(file)}`;
  }
}

/** "12 KB", "1.4 MB". */
export function byteSize(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The image type to ask the clipboard for: the first one offered that the server takes, PNG first. */
export function pickImageType(offered: string[]): ImageMimeType | null {
  const types = offered.map((t) => t.trim().toLowerCase());
  for (const want of ["image/png", "image/jpeg", "image/webp", "image/gif"] as const) if (types.includes(want)) return want;
  return null;
}

/** The clipboard tool for this session: wl-paste under Wayland, xclip under X11, none otherwise. */
export function clipboardTool(env: Record<string, string | undefined>): { list: [string, string[]]; read: (type: string) => [string, string[]] } | null {
  if (env.WAYLAND_DISPLAY) return { list: ["wl-paste", ["--list-types"]], read: (type) => ["wl-paste", ["--no-newline", "--type", type]] };
  if (env.DISPLAY) return { list: ["xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]], read: (type) => ["xclip", ["-selection", "clipboard", "-t", type, "-o"]] };
  return null;
}

function run(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: MAX_IMAGE_BYTES + 1024, timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** The image on the clipboard through wl-paste or xclip: bytes, "empty" when it holds no image, or "unsupported" without a tool. */
export async function clipboardImageByTool(env: Record<string, string | undefined>): Promise<Uint8Array | "empty" | "unsupported"> {
  const tool = clipboardTool(env);
  if (!tool) return "unsupported";
  const listed = await run(...tool.list);
  if (listed === null) return "unsupported";
  const type = pickImageType(listed.toString("utf8").split("\n"));
  if (!type) return "empty";
  const bytes = await run(...tool.read(type));
  return bytes && bytes.length > 0 ? new Uint8Array(bytes) : "empty";
}
