// The pure core of an agent-rendered HTML page: the bootstrap markup that is
// injected before a page is stored, the frame-height fitting math, and the
// tool-result normalization that attaches a reference to a tool card (with its
// spoof guard). No harness, no server.
import { describe, expect, it } from "vitest";
import { HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MIN_HEIGHT } from "../../src/shared/protocol.js";
import {
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderTitle,
  injectHtmlRenderBootstrap,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "../../src/shared/html-render.js";
import { HTML_RENDER_MCP_TOOL, htmlRenderFromDetails } from "../../src/server/harness/render-token.js";

const ref = (over: Partial<{ id: string; height: number; heights: Array<readonly [number, number]> }> = {}) => ({
  id: "a".repeat(32),
  title: "Page",
  height: 320,
  ...over,
});

describe("injectHtmlRenderBootstrap", () => {
  it("injects the bootstrap after the head tag", () => {
    const out = injectHtmlRenderBootstrap('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    expect(out.indexOf("<head>")).toBeLessThan(out.indexOf("awui-html-render-theme"));
    expect(out.indexOf("awui-html-render-theme")).toBeLessThan(out.indexOf('<meta charset'));
  });

  it("prepends when the document has no head", () => {
    const out = injectHtmlRenderBootstrap("<p>bare</p>");
    expect(out.startsWith("<script>")).toBe(true);
    expect(out).toContain("<p>bare</p>");
  });

  it("matches a head tag with attributes", () => {
    const out = injectHtmlRenderBootstrap('<html><head lang="en"><title>t</title>');
    expect(out).toContain('lang="en"><script>');
  });
});

describe("htmlRenderFrameHeight", () => {
  it("clamps the agent's height into the allowed band", () => {
    expect(htmlRenderFrameHeight(ref({ height: 5 }), 728)).toBe(HTML_RENDER_MIN_HEIGHT);
    expect(htmlRenderFrameHeight(ref({ height: 99999 }), 728)).toBe(HTML_RENDER_MAX_HEIGHT);
  });

  it("uses the page's own content height when it reports one", () => {
    expect(htmlRenderFrameHeight(ref({ height: 320 }), 728, 480)).toBe(480);
  });

  it("picks the nearest measured height for the frame's width", () => {
    const heights: Array<readonly [number, number]> = [
      [320, 200],
      [728, 400],
      [1144, 300],
    ];
    expect(htmlRenderFrameHeight(ref({ heights }), 728)).toBe(400);
    // Between two widths, a breakpoint could make the page as tall as either side.
    expect(htmlRenderFrameHeight(ref({ heights }), 500)).toBe(400);
  });
});

describe("pages and titles", () => {
  it("sanitizes a title for the file name and display", () => {
    expect(htmlRenderTitle("  Q3 Report! ")).toBe("Q3 Report!");
    expect(htmlRenderTitle("")).toBe("HTML");
    expect(htmlRenderTitle(42)).toBe("HTML");
    expect(htmlRenderFileName("Q3 Report!")).toBe("q3-report.html");
  });
});

describe("htmlRenderFromDetails", () => {
  const details = { htmlRender: { id: "b".repeat(32), title: "Report", height: 240 } };

  it("attaches the reference for the render tool itself", () => {
    expect(htmlRenderFromDetails("render_html", details)).toMatchObject({ id: "b".repeat(32), title: "Report", height: 240 });
    expect(htmlRenderFromDetails(HTML_RENDER_MCP_TOOL, details)?.height).toBe(240);
  });

  it("ignores the same shape on any other tool (spoof guard)", () => {
    expect(htmlRenderFromDetails("read", details)).toBeUndefined();
    expect(htmlRenderFromDetails("awui.render_html_evil", details)).toBeUndefined();
  });

  it("rejects a malformed reference", () => {
    expect(htmlRenderFromDetails("render_html", { htmlRender: { id: "nope", title: "x", height: 100 } })).toBeUndefined();
    expect(htmlRenderFromDetails("render_html", { htmlRender: { id: "b".repeat(32), title: "x" } })).toBeUndefined();
    expect(htmlRenderFromDetails("render_html", null)).toBeUndefined();
    expect(htmlRenderFromDetails("render_html", {})).toBeUndefined();
  });
});

describe("wire readers", () => {
  it("reads a content height only from the height message", () => {
    expect(readHtmlRenderContentHeight({ method: "awui-html-render/height", height: 480 })).toBe(480);
    expect(readHtmlRenderContentHeight({ method: "awui-html-render/height", height: -1 })).toBeUndefined();
    expect(readHtmlRenderContentHeight({ method: "other", height: 480 })).toBeUndefined();
    expect(readHtmlRenderContentHeight(null)).toBeUndefined();
  });

  it("reads a link request only for http(s) urls", () => {
    expect(readHtmlRenderLinkRequest({ method: "awui-html-render/open-link", id: 1, url: "https://x.test" })).toEqual({ id: 1, url: "https://x.test" });
    expect(readHtmlRenderLinkRequest({ method: "awui-html-render/open-link", id: 1, url: "javascript:alert(1)" })).toBeUndefined();
    expect(readHtmlRenderLinkRequest({ method: "awui-html-render/open-link", id: "1", url: "https://x.test" })).toBeUndefined();
  });

  it("builds a theme fragment the bootstrap can read back", () => {
    const fragment = htmlRenderThemeFragment({ appearance: "dark", variables: { "--bg": "#000" } });
    expect(fragment.startsWith("#awui-theme=")).toBe(true);
    expect(decodeURIComponent(fragment.slice("#awui-theme=".length))).toContain('"--bg":"#000"');
  });
});
