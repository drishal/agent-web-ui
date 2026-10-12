// atui's look-and-feel logic, apart from the drawing: the shimmer, paced
// streaming, meters, eased scrolling, the minimap, word-level diffs, task
// boxes, mentions, ghost text, picker highlights, and toasts.
import { describe, expect, it } from "vitest";
import type { ProjectSession } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { applyMention, ghostCompletion, matchSpans, mentionAt, newsBetween, notifySequence, tipAt, TIPS } from "../../src/atui/assist.js";
import { meter, mix, revealCut, revealStep, scrollPath, shimmer, sparkline, spinnerFor } from "../../src/atui/fx.js";
import { filetypeOf, taskBoxes } from "../../src/atui/markdown.js";
import { minimapCells, pinnedTurn, rowToScroll } from "../../src/atui/minimap.js";
import { KEYS_HELP, LEADER_KEYS, whichKeyColumns, whichKeyGrid } from "../../src/atui/keys.js";
import { highlightPreview, wordDiff } from "../../src/atui/words.js";
import { attachmentFrom, byteSize, clipboardTool, imageModeFrom, imagePathsFromPaste, imageProtocol, pickImageType } from "../../src/atui/images.js";

// A 2×2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

describe("fx", () => {
  it("mixes colours and sweeps a shimmer band across a label", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#102030", "#102030", 0.7)).toBe("#102030");
    const frame = shimmer(10, 6, "#000000", "#ffffff");
    expect(frame).toHaveLength(10);
    // The band's head (frame 6 - band 4 = char 2) is the brightest; far away is the base.
    expect(frame[2]).toBe("#ffffff");
    expect(frame[9]).toBe("#000000");
  });

  it("reveals streamed text at a steady pace, catching up when far behind", () => {
    expect(revealStep(0, 10, 33)).toBeLessThan(10);
    expect(revealStep(10, 10, 33)).toBe(10);
    // 3000 characters behind: a few frames, not seconds.
    let shown = 0;
    let frames = 0;
    while (shown < 3000 && frames < 100) {
      shown = revealStep(shown, 3000, 33);
      frames++;
    }
    expect(frames).toBeLessThan(40);
    expect(revealCut("hello wonderful world", 13)).toBe("hello");
    expect(revealCut("abc", 10)).toBe("abc");
  });

  it("draws sparklines and meters with block characters", () => {
    expect(sparkline([0, 50, 100])).toBe("▁▅█");
    expect(sparkline([])).toBe("");
    expect(meter(0.5, 4)).toBe("██  ");
    expect(meter(1, 3)).toBe("███");
    expect(meter(0.1, 4)).toHaveLength(4);
  });

  it("eases a scroll and lands exactly on the target", () => {
    const path = scrollPath(0, 100, 6);
    expect(path).toHaveLength(6);
    expect(path[path.length - 1]).toBe(100);
    // Ease-out: the first step is the biggest.
    expect((path[0] as number) > (path[1] as number) - (path[0] as number)).toBe(true);
  });

  it("gives each harness its own spinner", () => {
    expect(spinnerFor("claude")).not.toEqual(spinnerFor("pi"));
    expect(spinnerFor("unknown")).toEqual(spinnerFor("pi"));
    for (const id of ["pi", "omp", "claude", "hermes"]) for (const frame of spinnerFor(id)) expect([...frame]).toHaveLength(1);
  });
});

describe("minimap", () => {
  it("puts one tick per turn and marks the visible stretch", () => {
    const cells = minimapCells(
      [
        { top: 0, tone: "plain" },
        { top: 50, tone: "edited" },
        { top: 90, tone: "failed" },
      ],
      100,
      40,
      20,
      10,
    );
    expect(cells.map((c) => c.tone)).toEqual(["plain", null, null, null, null, "edited", null, null, null, "failed"]);
    expect(cells.map((c) => c.inView)).toEqual([false, false, false, false, true, true, false, false, false, false]);
  });

  it("maps a click back to a scroll position, clamped", () => {
    expect(rowToScroll(0, 10, 100, 20)).toBe(0);
    expect(rowToScroll(9, 10, 100, 20)).toBe(80);
    expect(rowToScroll(5, 10, 100, 20)).toBe(45);
  });

  it("pins the turn whose prompt scrolled away while its answer is on screen", () => {
    expect(pinnedTurn([0, 40, 90], 0)).toBeNull();
    expect(pinnedTurn([0, 40, 90], 10)).toBe(0);
    expect(pinnedTurn([0, 40, 90], 50)).toBe(1);
    // The next prompt is right at the top: nothing to pin.
    expect(pinnedTurn([0, 40, 90], 40)).toBeNull();
  });
});

describe("word-level diff", () => {
  it("finds the words that changed in a replaced line", () => {
    const d = wordDiff("const total = price * qty;", "const total = price * quantity;");
    expect(d.before.filter((s) => s.changed).map((s) => s.text)).toEqual(["qty"]);
    expect(d.after.filter((s) => s.changed).map((s) => s.text)).toEqual(["quantity"]);
  });

  it("marks a rewritten line changed throughout", () => {
    const d = wordDiff("alpha beta", "gamma delta");
    expect(d.before).toEqual([{ text: "alpha beta", changed: true }]);
  });

  it("pairs removed and added runs line for line in a preview", () => {
    const lines = highlightPreview([
      { marker: " ", text: "x" },
      { marker: "-", text: "let a = 1;" },
      { marker: "+", text: "let a = 2;" },
      { marker: "+", text: "let b = 3;" },
    ]);
    expect(lines[1]?.segments.find((s) => s.changed)?.text).toBe("1");
    expect(lines[2]?.segments.find((s) => s.changed)?.text).toBe("2");
    expect(lines[3]?.segments).toEqual([{ text: "let b = 3;", changed: true }]);
    expect(lines[0]?.segments).toEqual([{ text: "x", changed: false }]);
  });
});

describe("markdown", () => {
  it("draws task lists as boxes, but not inside code", () => {
    expect(taskBoxes("- [ ] write\n- [x] test\n* [X] ship")).toBe("- ☐ write\n- ☑ test\n* ☑ ship");
    expect(taskBoxes("```\n- [ ] code\n```")).toBe("```\n- [ ] code\n```");
    expect(taskBoxes("a [link](x)")).toBe("a [link](x)");
  });

  it("names a file's language from its extension", () => {
    expect(filetypeOf("src/app.tsx")).toBe("tsx");
    expect(filetypeOf("flake.nix")).toBe("nix");
    expect(filetypeOf("Makefile")).toBeUndefined();
  });
});

describe("composer and picker helpers", () => {
  it("finds an @mention being typed and replaces it with the file", () => {
    expect(mentionAt("look at @src/ap")).toEqual({ query: "src/ap", start: 8 });
    expect(mentionAt("@")).toEqual({ query: "", start: 0 });
    expect(mentionAt("mail me@x.com")).toBeNull();
    expect(mentionAt("done @a ")).toBeNull();
    expect(applyMention("look at @src/ap", "src/app.ts")).toBe("look at @src/app.ts ");
  });

  it("ghosts the rest of the best slash command", () => {
    const cmd = { name: "compact", source: "app" } as const;
    expect(ghostCompletion("/com", cmd)).toBe("pact");
    expect(ghostCompletion("/compact", cmd)).toBe("");
    expect(ghostCompletion("/compact now", cmd)).toBe("");
    expect(ghostCompletion("/x", cmd)).toBe("");
  });

  it("highlights the letters a search matched", () => {
    expect(matchSpans("Choose model", "mod")).toEqual([
      { text: "Choose ", hit: false },
      { text: "mod", hit: true },
      { text: "el", hit: false },
    ]);
    expect(matchSpans("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });

  it("toasts a background session that finished, failed, or asks", () => {
    const s = (id: string, extra: Partial<ProjectSession>): ProjectSession => ({ id, harnessId: asHarnessId("pi"), title: id, updatedAt: null, workspaceId: "w", ...extra });
    const before = [s("a", { status: "running" }), s("b", { status: "running" }), s("c", { status: "idle" }), s("shown", { status: "running" })];
    const after = [s("a", { status: "idle" }), s("b", { status: "error" }), s("c", { status: "idle", asking: true }), s("shown", { status: "idle" })];
    expect(newsBetween(before, after, "shown").map((n) => `${n.sessionId}:${n.kind}`)).toEqual(["a:done", "b:failed", "c:asking"]);
    expect(newsBetween(null, after, null)).toEqual([]);
  });

  it("asks the terminal for a notification, without letting a title inject escapes", () => {
    expect(notifySequence({ TERM: "foot" }, "Done", "fix it")).toBe("\x1b]777;notify;Done;fix it\x1b\\");
    expect(notifySequence({ TERM: "xterm-kitty" }, "Done", "x")).toBe("\x1b]9;Done: x\x1b\\");
    const evil = notifySequence({ TERM: "foot" }, "Done", "a\x1b]52;c;ZXZpbA==\x07b");
    expect(evil).not.toContain("\x1b]52");
    expect(evil.match(/\x1b/g)).toHaveLength(2);
  });

  it("rotates the tips", () => {
    expect(tipAt(0)).toBe(TIPS[0]);
    expect(tipAt(8000)).toBe(TIPS[1]);
  });
});

describe("images", () => {
  it("picks kitty's protocol in kitty and Ghostty, half blocks in tmux, and honours an explicit mode", () => {
    expect(imageProtocol(null, { TERM: "xterm-kitty" })).toBe("kitty");
    expect(imageProtocol(null, { TERM_PROGRAM: "ghostty" })).toBe("kitty");
    expect(imageProtocol(null, { GHOSTTY_RESOURCES_DIR: "/x" })).toBe("kitty");
    expect(imageProtocol(null, { TERM: "xterm-256color" })).toBe("auto");
    expect(imageProtocol(null, { TERM: "xterm-kitty", TMUX: "/tmp/tmux" })).toBe("blocks");
    expect(imageProtocol("sixel", { TERM: "xterm-kitty" })).toBe("sixel");
    expect(imageProtocol("off", {})).toBeNull();
    expect(imageModeFrom(undefined, { ATUI_IMAGES: "Kitty" })).toBe("kitty");
    expect(imageModeFrom("nope", {})).toBeNull();
  });

  it("reads a paste of dropped image files as paths, and anything else as text", () => {
    expect(imagePathsFromPaste("/tmp/a.png", "/w")).toEqual(["/tmp/a.png"]);
    expect(imagePathsFromPaste("'/tmp/my shot.png' shots/b.JPG", "/w")).toEqual(["/tmp/my shot.png", "/w/shots/b.JPG"]);
    expect(imagePathsFromPaste("/tmp/my\\ shot.webp", "/w")).toEqual(["/tmp/my shot.webp"]);
    expect(imagePathsFromPaste("file:///tmp/a%20b.gif", "/w")).toEqual(["/tmp/a b.gif"]);
    expect(imagePathsFromPaste("~/x.png", "/w", "/home/u")).toEqual(["/home/u/x.png"]);
    expect(imagePathsFromPaste("look at /tmp/a.png", "/w")).toBeNull();
    expect(imagePathsFromPaste("notes.txt", "/w")).toBeNull();
  });

  it("reads the clipboard with wl-paste or xclip, asking for an image type the server takes", () => {
    expect(pickImageType(["text/plain", "image/jpeg", "image/png"])).toBe("image/png");
    expect(pickImageType(["image/bmp", "text/plain"])).toBeNull();
    expect(clipboardTool({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" })?.read("image/png")).toEqual(["wl-paste", ["--no-newline", "--type", "image/png"]]);
    expect(clipboardTool({ DISPLAY: ":0" })?.list[0]).toBe("xclip");
    expect(clipboardTool({})).toBeNull();
  });

  it("checks an attachment by its bytes", () => {
    const ok = attachmentFrom(new Uint8Array(PNG));
    expect(typeof ok === "string" ? ok : ok.mimeType).toBe("image/png");
    expect(attachmentFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toMatch(/not a PNG/);
    expect(byteSize(900)).toBe("1 KB");
    expect(byteSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("keys", () => {
  it("writes keys the Emacs way and lays C-x out column by column like which-key", () => {
    expect(KEYS_HELP).toContain("C-k commands");
    expect(KEYS_HELP).not.toMatch(/\^|Ctrl\+/);
    expect(new Set(LEADER_KEYS.map((k) => k.key)).size).toBe(LEADER_KEYS.length);
    expect(whichKeyGrid(14, 100, 34)).toEqual({ columns: 2, rows: 7 });
    expect(whichKeyColumns([1, 2, 3, 4, 5], 100, 34)).toEqual([[1, 2, 3], [4, 5]]);
    expect(whichKeyColumns([1, 2], 10, 34)).toEqual([[1, 2]]);
  });
});
