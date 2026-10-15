import { describe, expect, it } from "vitest";
import { highlightLines, languageOf, type Token } from "../../src/web/highlight.js";

/** A line's coloured runs as "kind:text", plain text left out. */
const runs = (line: Token[] | undefined) => (line ?? []).filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`);

describe("the file viewer's colours", () => {
  it("knows a language by its extension or its name", () => {
    expect(languageOf("src/app.tsx")).toBe("js");
    expect(languageOf("flake.nix")).toBe("nix");
    expect(languageOf("Makefile")).toBe("sh");
    expect(languageOf("notes/README.md")).toBe("md");
    expect(languageOf("LICENSE")).toBeNull();
  });

  it("colours keywords, strings, numbers, literals, types, and comments", () => {
    const [line] = highlightLines('const answer: Answer = "forty" + 2 ?? null; // why', "js");
    expect(runs(line)).toEqual(["keyword:const", "type:Answer", 'string:"forty"', "number:2", "literal:null", "comment:// why"]);
  });

  it("carries a block comment and a template string across lines", () => {
    const lines = highlightLines("a /* one\ntwo */ b\nconst s = `x\ny` + 1", "js");
    expect(runs(lines[0])).toEqual(["comment:/* one"]);
    expect(runs(lines[1])).toEqual(["comment:two */"]);
    expect(runs(lines[2])).toEqual(["keyword:const", "string:`x"]);
    expect(runs(lines[3])).toEqual(["string:y`", "number:1"]);
  });

  it("does not take an escaped quote, an apostrophe, or a word's digits for anything", () => {
    expect(runs(highlightLines('x = "a\\"b" + c2', "py")[0])).toEqual(['string:"a\\"b"']);
    expect(runs(highlightLines("# don't stop", "py")[0])).toEqual(["comment:# don't stop"]);
    expect(runs(highlightLines("it's fine", "rb")[0])).toEqual([]);
  });

  it("marks a YAML key, a TOML key, and a Markdown heading and code", () => {
    expect(runs(highlightLines("  name: awui # the app", "yaml")[0])).toEqual(["key:name", "comment:# the app"]);
    expect(runs(highlightLines("- port: 4783", "yaml")[0])).toEqual(["key:port", "number:4783"]);
    expect(runs(highlightLines('version = "1.2"', "toml")[0])).toEqual(["key:version", 'string:"1.2"']);
    const md = highlightLines("# Title\nrun `npm test`\n```\ncode\n```", "md");
    expect(md.map(runs)).toEqual([["heading:# Title"], ["string:`npm test`"], ["comment:```"], ["string:code"], ["comment:```"]]);
  });

  it("keeps a dash inside a word only where words have them", () => {
    expect(runs(highlightLines("count-1", "js")[0])).toEqual(["number:1"]);
    expect(runs(highlightLines("--no-color 1", "sh")[0])).toEqual(["number:1"]);
  });

  it("leaves a language it does not know as plain lines", () => {
    expect(highlightLines("a\nb", null)).toEqual([[{ kind: "plain", text: "a" }], [{ kind: "plain", text: "b" }]]);
  });
});
