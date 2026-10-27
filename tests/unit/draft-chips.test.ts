// The composer's chips (draft-chips.ts): a view of the draft that gives the same text back.
import { describe, expect, it } from "vitest";
import { chipLabel, draftPieces, withoutPiece, type DraftPiece } from "../../src/web/draft-chips.js";
import { serializeDraft } from "../../src/web/draft-segments.js";

const kinds = (pieces: DraftPiece[]) => pieces.map((p) => (p.kind === "text" ? p.raw : `[${p.kind}:${p.raw}]`));
const joined = (pieces: DraftPiece[]) => pieces.map((p) => p.raw).join("");

describe("the composer's chips", () => {
  it("finds file references with a line or a range, and leaves words and addresses alone", () => {
    const text = "In @src/web/find.ts at @src/web/find.ts:44-58 and @a.ts:3, not @someone or me@x.org.";
    const pieces = draftPieces(text);
    expect(kinds(pieces)).toEqual(["In ", "[file:@src/web/find.ts]", " at ", "[file:@src/web/find.ts:44-58]", " and ", "[file:@a.ts:3]", ", not @someone or me@x.org."]);
    expect(pieces[3]).toMatchObject({ path: "src/web/find.ts", line: 44, end: 58 });
    expect(joined(pieces)).toBe(text);
  });

  it("takes a quote block with the blank lines around it, so it sits in the sentence", () => {
    const text = "the comment says\n\n> a fold opens\n> when a match lands\n\n— make it do that";
    const pieces = draftPieces(text);
    expect(kinds(pieces)).toEqual(["the comment says", "[quote:\n\n> a fold opens\n> when a match lands\n\n]", "— make it do that"]);
    expect(pieces[1]).toMatchObject({ text: "a fold opens\nwhen a match lands" });
    expect(joined(pieces)).toBe(text);
    // At the start, and as the quote button leaves it (a blank line after, nothing typed yet).
    expect(kinds(draftPieces("> hi\n\n"))).toEqual(["[quote:> hi\n\n]"]);
    expect(kinds(draftPieces("> hi\n"))).toEqual(["[quote:> hi\n]"]);
  });

  it("gives back exactly what draft-segments writes, so the wire text does not change", () => {
    const wire = serializeDraft([{ kind: "text", text: "look at" }, { kind: "file", path: "src/a.ts", line: 2 }, { kind: "text", text: " then" }, { kind: "quote", text: "one\ntwo" }, { kind: "text", text: "ok" }]);
    const pieces = draftPieces(wire);
    expect(joined(pieces)).toBe(wire);
    expect(pieces.filter((p) => p.kind !== "text").map((p) => p.kind)).toEqual(["file", "quote"]);
  });

  it("keeps a reference the caret is still typing as text", () => {
    expect(kinds(draftPieces("see @src/a.ts", 13))).toEqual(["see @src/a.ts"]);
    expect(kinds(draftPieces("see @src/a.ts more", 13))).toEqual(["see @src/a.ts more"]);
    expect(kinds(draftPieces("see @src/a.ts ", 14))).toEqual(["see ", "[file:@src/a.ts]", " "]);
  });

  it("labels a range of a file already named by its lines alone", () => {
    const pieces = draftPieces("@src/f.ts at @src/f.ts:44-58 and @src/g.ts:3");
    const chips = pieces.filter((p) => p.kind !== "text");
    const label = (p: DraftPiece) => chipLabel(p, pieces.slice(0, pieces.indexOf(p)));
    expect(label(chips[1] as DraftPiece)).toMatchObject({ lines: "44–58", linesOnly: true });
    expect(label(chips[2] as DraftPiece)).toMatchObject({ label: "src/g.ts", lines: "3", linesOnly: false });
  });

  it("removes a chip's text and nothing else", () => {
    const text = "fix @src/a.ts now";
    const chip = draftPieces(text).find((p) => p.kind === "file") as DraftPiece;
    expect(withoutPiece(text, chip)).toBe("fix now");
    const quoted = "says\n\n> q\n\n— go";
    const quote = draftPieces(quoted).find((p) => p.kind === "quote") as DraftPiece;
    expect(withoutPiece(quoted, quote)).toBe("says — go");
  });
});
