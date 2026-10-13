// Prompt links (prompt-link.ts): a prompt in a URL, hidden characters taken out.
import { describe, expect, it } from "vitest";
import { linkedPrompt, promptLink } from "../../src/web/prompt-link.js";

describe("prompt links", () => {
  it("carries a prompt in the URL and takes out characters that would hide from a reader", () => {
    const url = promptLink("https://awui.local", "fix the bug & add tests");
    expect(new URL(url).searchParams.get("prompt")).toBe("fix the bug & add tests");
    expect(linkedPrompt("read me​‮evil⁦")).toEqual({ text: "read meevil", hidden: 3 });
    expect(linkedPrompt("tag\u{E0041}\u{E0042}").hidden).toBe(2);
    expect(linkedPrompt("a\r\nb").text).toBe("a\nb");
    expect(linkedPrompt("x".repeat(10_000)).text.length).toBe(8000);
  });
});
