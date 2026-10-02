import { describe, expect, it } from "vitest";
import { sniffImage } from "../../src/server/images.js";

const b64 = (bytes: number[] | string) => Buffer.from(typeof bytes === "string" ? bytes : Uint8Array.from(bytes)).toString("base64");

describe("sniffImage", () => {
  it("recognises PNG, JPEG, GIF and WebP by their magic bytes", () => {
    expect(sniffImage(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(sniffImage(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("image/jpeg");
    expect(sniffImage(b64("GIF89a\u0001\u0000"))).toBe("image/gif");
    expect(sniffImage(b64("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
  });

  it("rejects anything else", () => {
    expect(sniffImage(b64("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(b64("%PDF-1.7\n"))).toBeNull();
    expect(sniffImage(b64("RIFF\u0000\u0000\u0000\u0000WAVEfmt "))).toBeNull();
  });
});
