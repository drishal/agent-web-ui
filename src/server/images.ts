// An attachment must really be the image type it claims: providers reject a
// mismatch mid-run, and this keeps arbitrary files out of prompts.
import type { ImageMimeType } from "../shared/protocol.js";

/** The image type from the file's magic bytes, or null when it is none we accept. */
export function sniffImage(base64: string): ImageMimeType | null {
  const b = Buffer.from(base64.slice(0, 24), "base64");
  if (b.length >= 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}
