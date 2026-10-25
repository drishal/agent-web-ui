// Which files the viewer offers to render (preview.ts). The bytes always come
// from the project's own read-only file view; this only picks the offer.
import { describe, expect, it } from "vitest";
import { previewKind } from "../../src/web/preview.js";

describe("the viewer's preview offer", () => {
  it("is Markdown for a .md or .markdown file, in any case", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("docs/Guide.MD")).toBe("markdown");
    expect(previewKind("notes/a.markdown")).toBe("markdown");
    expect(previewKind("dir.with.dots/x.md")).toBe("markdown");
    expect(previewKind("page.html")).toBe("html");
    expect(previewKind("a/b/Index.HTM")).toBe("html");
    expect(previewKind("shot.png")).toBe("image");
    expect(previewKind("b/Photo.JPEG")).toBe("image");
    expect(previewKind("logo.svg")).toBeNull();
  });

  it("is nothing for source, a dotfile, or a name ending in a dot", () => {
    expect(previewKind("src/app.ts")).toBeNull();
    expect(previewKind("a.md.txt")).toBeNull();
    expect(previewKind("Makefile")).toBeNull();
    expect(previewKind(".md")).toBeNull();
    expect(previewKind("weird.")).toBeNull();
    expect(previewKind("")).toBeNull();
  });
});
