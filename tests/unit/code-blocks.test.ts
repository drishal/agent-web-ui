import { describe, expect, it } from "vitest";
import { gutterDigits, highlightLanguage, languageLabel, MAX_RICH_BYTES, MAX_RICH_LINES, NUMBERED_FROM, richBlock } from "../../src/web/code-blocks.js";

describe("a code block's header", () => {
  it("cases a known language's name and leaves any other as written", () => {
    expect(languageLabel("typescript")).toBe("TypeScript");
    expect(languageLabel("TS")).toBe("TypeScript");
    expect(languageLabel("tsx")).toBe("TSX");
    expect(languageLabel("json")).toBe("JSON");
    expect(languageLabel("yml")).toBe("YAML");
    expect(languageLabel("c++")).toBe("C++");
    expect(languageLabel("py")).toBe("Python");
    expect(languageLabel("bash")).toBe("bash");
    expect(languageLabel("zsh")).toBe("zsh");
    expect(languageLabel("gleam")).toBe("gleam");
  });

  it("names nothing for an unlabeled block", () => {
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel("")).toBeNull();
    expect(languageLabel("  ")).toBeNull();
  });
});

describe("a code block's colours", () => {
  it("finds highlight.ts's language from a fence's name or extension", () => {
    expect(highlightLanguage("typescript")).toBe("js");
    expect(highlightLanguage("ts")).toBe("js");
    expect(highlightLanguage("python")).toBe("py");
    expect(highlightLanguage("Rust")).toBe("rs");
    expect(highlightLanguage("shell")).toBe("sh");
    expect(highlightLanguage("console")).toBe("sh");
    expect(highlightLanguage("bash")).toBe("sh");
    expect(highlightLanguage("c++")).toBe("c");
    expect(highlightLanguage("postgresql")).toBe("sql");
    expect(highlightLanguage("yaml")).toBe("yaml");
  });

  it("leaves a language it does not know plain", () => {
    expect(highlightLanguage("gleam")).toBeNull();
    expect(highlightLanguage("diff")).toBeNull();
    expect(highlightLanguage("text")).toBeNull();
    expect(highlightLanguage(null)).toBeNull();
  });

  it("skips colours and numbers past 2000 lines or 100 KB", () => {
    expect(richBlock("a\n".repeat(MAX_RICH_LINES))).toBe(true);
    expect(richBlock("a\n".repeat(MAX_RICH_LINES + 1))).toBe(false);
    expect(richBlock("x".repeat(MAX_RICH_BYTES))).toBe(true);
    expect(richBlock("x".repeat(MAX_RICH_BYTES + 1))).toBe(false);
  });
});

describe("a code block's line numbers", () => {
  it("start at six lines", () => {
    expect(NUMBERED_FROM).toBe(6);
  });

  it("widen the gutter by the digits of the last line", () => {
    expect(gutterDigits(6)).toBe(1);
    expect(gutterDigits(9)).toBe(1);
    expect(gutterDigits(10)).toBe(2);
    expect(gutterDigits(2000)).toBe(4);
    expect(gutterDigits(0)).toBe(1);
  });
});
