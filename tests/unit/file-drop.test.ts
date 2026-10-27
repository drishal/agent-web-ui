// Files dropped on the composer that are not images (file-drop.ts): matching by name, what cannot be uploaded, and where `@path` lands.
import { describe, expect, it } from "vitest";
import { addQuestion, dropHint, hasOtherFiles, insertReference, matchProjectFile, MAX_UPLOAD_BYTES, uploadProblem } from "../../src/web/file-drop.js";
import { draftPieces } from "../../src/web/draft-chips.js";

describe("which project file a dropped name is", () => {
  const files = ["README.md", "src/web/find.ts", "src/server/find.ts", "docs/notes.json", "notes.json.bak", "src/find.tsx"];

  it("is the one file with that name, wherever it sits", () => {
    expect(matchProjectFile("README.md", files)).toEqual({ kind: "one", path: "README.md" });
    expect(matchProjectFile("notes.json", files)).toEqual({ kind: "one", path: "docs/notes.json" });
  });

  it("lists every file of that name when there are several", () => {
    expect(matchProjectFile("find.ts", files)).toEqual({ kind: "many", paths: ["src/web/find.ts", "src/server/find.ts"] });
  });

  it("is none when only a longer name or a folder name matches", () => {
    expect(matchProjectFile("notes", files)).toEqual({ kind: "none" });
    expect(matchProjectFile("find", files)).toEqual({ kind: "none" });
    expect(matchProjectFile("src", files)).toEqual({ kind: "none" });
    expect(matchProjectFile("Readme.md", files)).toEqual({ kind: "none" });
    expect(matchProjectFile("a.txt", [])).toEqual({ kind: "none" });
  });
});

describe("what cannot be added to the project", () => {
  it("is an empty file (or a folder) and one past the upload limit, named", () => {
    expect(uploadProblem({ name: "a.txt", size: 0 })).toContain("a.txt is empty");
    expect(uploadProblem({ name: "big.bin", size: MAX_UPLOAD_BYTES + 1 })).toBe("big.bin is 8.0 MB; a file added to the project can be at most 8 MB");
    expect(uploadProblem({ name: "ok.bin", size: MAX_UPLOAD_BYTES })).toBeNull();
    expect(uploadProblem({ name: "notes.json", size: 12 })).toBeNull();
  });

  it("asks about one file by name, and about several by count", () => {
    expect(addQuestion(["notes.json"])).toBe("notes.json is not in the project — Add it to the project?");
    expect(addQuestion(["a.txt", "b.txt"])).toBe("2 files are not in the project — Add them to the project?");
  });
});

describe("what the card says while files are dragged over it", () => {
  const png = { kind: "file", type: "image/png" };
  const json = { kind: "file", type: "application/json" };
  it("names files to reference once one is not an image", () => {
    expect(dropHint([png])).toBe("Drop images to attach");
    expect(dropHint([png, json])).toBe("Drop images to attach, or files to reference");
    expect(hasOtherFiles([{ kind: "file", type: "" }])).toBe(true);
    expect(hasOtherFiles([{ kind: "string", type: "text/plain" }])).toBe(false);
    expect(hasOtherFiles([])).toBe(false);
  });
});

describe("putting a reference into the draft", () => {
  it("sets it off by spaces, and leaves the caret after it", () => {
    expect(insertReference("", 0, 0, "@a.ts")).toEqual({ text: "@a.ts ", caret: 6 });
    expect(insertReference("see", 3, 3, "@a.ts")).toEqual({ text: "see @a.ts ", caret: 10 });
    expect(insertReference("see this", 3, 3, "@a.ts")).toEqual({ text: "see @a.ts this", caret: 10 });
  });

  it("does not double a space that is already there, and steps over it", () => {
    expect(insertReference("see  now", 4, 4, "@a.ts")).toEqual({ text: "see @a.ts now", caret: 10 });
    const next = insertReference("see now", 3, 3, "@a.ts");
    expect(next.text.slice(next.caret)).toBe("now");
  });

  it("replaces a selection", () => {
    expect(insertReference("fix THIS now", 4, 8, "@a.ts")).toEqual({ text: "fix @a.ts now", caret: 10 });
  });

  it("chains: a second reference lands after the first, and both are chips", () => {
    const one = insertReference("see", 3, 3, "@a/b.ts");
    const two = insertReference(one.text, one.caret, one.caret, "@c.ts");
    expect(two.text).toBe("see @a/b.ts @c.ts ");
    expect(draftPieces(two.text).filter((p) => p.kind !== "text")).toHaveLength(2);
  });
});
