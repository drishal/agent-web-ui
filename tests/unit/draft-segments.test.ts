// A draft's segments (draft-segments.ts) serialize to the text the composer sends.
import { describe, expect, it } from "vitest";
import { fileReference, quoteBlock, serializeDraft } from "../../src/web/draft-segments.js";

describe("a draft made of segments", () => {
  it("writes a file reference as the @ mention the menus already insert", () => {
    expect(fileReference("src/app.ts")).toBe("@src/app.ts");
    expect(fileReference("src/app.ts", 12)).toBe("@src/app.ts:12");
    expect(serializeDraft([{ kind: "text", text: "look at" }, { kind: "file", path: "a.ts" }])).toBe("look at @a.ts");
    // Two references do not fuse, and one after a space does not double it.
    expect(serializeDraft([{ kind: "file", path: "a.ts" }, { kind: "file", path: "b.ts" }])).toBe("@a.ts @b.ts");
    expect(serializeDraft([{ kind: "text", text: "see " }, { kind: "file", path: "a.ts", line: 3 }])).toBe("see @a.ts:3");
  });

  it("writes a quote as a block quote, on its own paragraph", () => {
    expect(quoteBlock("one\ntwo")).toBe("> one\n> two");
    expect(quoteBlock("one\n\ntwo")).toBe("> one\n>\n> two");
    expect(serializeDraft([{ kind: "quote", text: "hi" }])).toBe("> hi\n");
    expect(serializeDraft([{ kind: "text", text: "reply:" }, { kind: "quote", text: "hi" }])).toBe("reply:\n\n> hi\n");
    // A quote after a blank line already does not add another.
    expect(serializeDraft([{ kind: "text", text: "a\n\n" }, { kind: "quote", text: "b" }])).toBe("a\n\n> b\n");
  });

  it("a text-only draft is exactly what was typed", () => {
    expect(serializeDraft([{ kind: "text", text: "plain words\nand a line" }])).toBe("plain words\nand a line");
    expect(serializeDraft([])).toBe("");
  });
});
