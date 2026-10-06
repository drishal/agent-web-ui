// Pasted, dropped, or picked images → attachments the server accepts. A
// supported type under the size cap goes through untouched (the harness resizes
// it for the model); anything else is redrawn with its longest side at most
// MAX_SIDE, as PNG, or JPEG when PNG is still too big.
import { IMAGE_MIME_TYPES, type ImageAttachment, type ImageMimeType, MAX_IMAGE_BYTES } from "../shared/protocol.js";

const MAX_SIDE = 2048;

export interface PendingImage extends ImageAttachment {
  /** Local key; crypto.randomUUID is missing on plain-HTTP LAN pages. */
  id: number;
  /** Pixel size as sent, for the thumbnail's label; null when the browser could not measure it. */
  width: number | null;
  height: number | null;
}

let nextId = 1;

const accepted = (type: string): type is ImageMimeType => (IMAGE_MIME_TYPES as readonly string[]).includes(type);

/** The image files in a paste or drop. */
export function imageFiles(files: FileList | null | undefined): File[] {
  return files ? [...files].filter((f) => f.type.startsWith("image/")) : [];
}

export function dataUrl(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

async function redraw(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file is not an image this browser can read");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const png = await encode("image/png");
  if (png && png.size <= MAX_IMAGE_BYTES) return png;
  const jpeg = await encode("image/jpeg", 0.85);
  if (jpeg && jpeg.size <= MAX_IMAGE_BYTES) return jpeg;
  throw new Error("That image is too large, even after shrinking it");
}

async function measure(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: null, height: null };
  }
}

export async function prepareImage(file: File): Promise<PendingImage> {
  const blob = accepted(file.type) && file.size <= MAX_IMAGE_BYTES ? file : await redraw(file);
  const mimeType = blob.type;
  if (!accepted(mimeType)) throw new Error("That image type is not supported");
  const [data, size] = await Promise.all([toBase64(blob), measure(blob)]);
  return { id: nextId++, mimeType, data, ...size };
}

