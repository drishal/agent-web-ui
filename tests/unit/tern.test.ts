import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Key } from "@stencil-hq/tern";
import type { ChatItem, ToolItem } from "../../src/shared/protocol.js";
import type { ChatState } from "../../src/web/chat-state.js";
import type { Node } from "@stencil-hq/tern";
import { applyEdit, draftState, editKey, lineStep, redo, setText, undo, wordStep, type DraftState } from "../../src/tern/draft.js";
import { filterItems, matchRanges, moveSelection } from "../../src/tern/overlays.js";
import { decorations, placeholder } from "../../src/tern/dock.js";
import { paletteFor } from "../../src/tern/look.js";
import { conversation, foldHead, toolNode, type ConversationCx } from "../../src/tern/view.js";
import { parseTernArgs } from "../../src/tern/args.js";
import { ternEntry } from "../../src/server/tern-client.js";
import { DARK } from "../../src/atui/theme.js";
import type { Turn, WorkSegment } from "../../src/web/turns.js";

const key = (name: string, over: Partial<Key> = {}): Key => ({ name, ctrl: false, alt: false, shift: false, meta: false, ...(name.length === 1 ? { text: name } : {}), ...over });

/** The draft after typing each key in turn. */
function typed(state: DraftState, ...keys: Key[]): DraftState {
  for (const k of keys) state = editKey(state, k) ?? state;
  return state;
}

describe("the Tern composer's draft", () => {
  it("types, moves, and deletes as the shell does", () => {
    let s = typed(draftState(), key("h"), key("i"), key("space"), key("t"), key("h"), key("e"), key("r"), key("e"));
    expect(s.draft).toEqual({ text: "hi there", cursor: 8, anchor: null });
    s = typed(s, key("w", { ctrl: true }));
    expect(s.draft.text).toBe("hi ");
    s = typed(s, key("a", { ctrl: true }), key("right"), key("delete"));
    expect(s.draft).toMatchObject({ text: "h ", cursor: 1 });
    s = typed(s, key("u", { ctrl: true }));
    expect(s.draft).toMatchObject({ text: " ", cursor: 0 });
  });

  it("undoes a typed word as one step, and redoes it", () => {
    let s = typed(draftState(), key("o"), key("n"), key("e"), key("space"), key("t"), key("w"), key("o"));
    s = undo(s);
    expect(s.draft.text).toBe("one ");
    s = undo(s);
    expect(s.draft.text).toBe("");
    expect(redo(redo(s)).draft.text).toBe("one two");
  });

  it("selects with Shift, and typing replaces the selection", () => {
    let s = setText(draftState(), "hello world");
    s = typed(s, key("left", { shift: true }), key("left", { shift: true }));
    expect(s.draft).toMatchObject({ cursor: 9, anchor: 11 });
    s = typed(s, key("!"));
    expect(s.draft.text).toBe("hello wor!");
  });

  it("takes a paste whole, its line ends as new lines", () => {
    const s = typed(draftState(), { name: "paste", text: "a\r\nb", ctrl: false, alt: false, shift: false, meta: false });
    expect(s.draft.text).toBe("a\nb");
  });

  it("leaves Enter, Esc, Tab, and the app's chords to the app", () => {
    for (const k of [key("enter"), key("escape"), key("tab"), key("k", { ctrl: true }), key("x", { ctrl: true })]) expect(editKey(draftState(), k)).toBeNull();
    // C-d deletes forward in text, and is the app's (quit) in an empty draft.
    expect(editKey(draftState(), key("d", { ctrl: true }))).toBeNull();
  });

  it("moves by line within the text, and says where the first or last line is", () => {
    const s = setText(draftState(), "ab\ncdef", 5);
    expect(lineStep(s.draft, -1)).toBe(2);
    expect(lineStep(s.draft, 1)).toBeNull();
    expect(lineStep({ text: "ab\ncd", cursor: 1, anchor: null }, -1)).toBeNull();
    expect(wordStep("foo  bar baz", 12, -1)).toBe(9);
    expect(wordStep("foo  bar baz", 0, 1)).toBe(3);
  });

  it("applies Tern's edit events, and ignores one made against an older text", () => {
    let s = setText(draftState(), "hello");
    s = applyEdit(s, { from: 0, to: 5, text: "bye", cursor: 3, len: 5 });
    expect(s.draft).toMatchObject({ text: "bye", cursor: 3 });
    expect(applyEdit(s, { from: 0, to: 1, text: "x", cursor: 1, len: 99 })).toBe(s);
    // A caret move alone is no undo step.
    const moved = applyEdit(s, { from: 1, to: 1, text: "", cursor: 1, len: 3 });
    expect(moved.draft.cursor).toBe(1);
    expect(moved.undo).toEqual(s.undo);
  });
});

describe("the Tern menus", () => {
  const items = [
    { id: "a", label: "Browse sessions" },
    { id: "b", label: "New chat", keywords: "start" },
    { id: "c", label: "Change the model…", detail: "session" },
  ];

  it("keep the rows with every word, label hits first", () => {
    expect(filterItems(items, "").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(filterItems(items, "ses").map((i) => i.id)).toEqual(["a", "c"]);
    expect(filterItems(items, "start").map((i) => i.id)).toEqual(["b"]);
    expect(filterItems(items, "chat zzz")).toEqual([]);
  });

  it("mark where the words are, and wrap the selection", () => {
    expect(matchRanges("Change the model", "mod ch")).toEqual([
      [0, 2],
      [11, 14],
    ]);
    expect(matchRanges("x", "y")).toBeNull();
    expect(moveSelection({ kind: "palette", query: "", selected: 0 }, 3, -1).selected).toBe(2);
    expect(moveSelection({ kind: "palette", query: "", selected: 2 }, 3, 1).selected).toBe(0);
  });
});

describe("the Tern dock", () => {
  it("colours @mentions and {{blanks}} in the draft", () => {
    expect(decorations("see @src/a.ts and {{why}}")).toEqual([
      { from: 4, to: 13, s: "accent" },
      { from: 18, to: 25, s: "warning mark" },
    ]);
  });

  it("asks for what fits the chat's state", () => {
    expect(placeholder(null, null, null)).toBe("Message the agent…");
    expect(placeholder(null, null, 3)).toMatch(/^Edit message 3/);
  });
});

describe("the Tern palette", () => {
  it("uses a theme file's colours only in its own appearance", () => {
    const dark = paletteFor(DARK, "#ff0000", "dark");
    expect(dark.dark?.text).toBe(DARK.text);
    expect(dark.light).toEqual({ harness: "#ff0000", thinking: DARK.thinking });
    const none = paletteFor(DARK, "#ff0000", null);
    expect(none.dark).toEqual(none.light);
    expect(none.dark?.text).toBeUndefined();
  });
});

const tool = (over: Partial<ToolItem>): ToolItem => ({ kind: "tool", id: "t1", name: "bash", args: "{}", status: "done", output: "", truncated: false, category: "command", summary: "", paths: [], ...over });

describe("the Tern conversation", () => {
  it("draws a command as Tern's tool row, its output folded under it", () => {
    const node = toolNode(tool({ args: JSON.stringify({ command: "npm test" }), output: "ok\n", at: 1000, endedAt: 3500 }), "/w", () => undefined);
    expect(node.kind).toBe("tool");
    expect(node.props).toMatchObject({ name: "bash", title: "Bash", target: "npm test", targetKind: "command", status: "done", took: 2500, collapsible: true, collapsed: true });
    expect(node.children[0]?.kind).toBe("ansi");
  });

  it("keeps a running command open, following its output, timed from its age", () => {
    const node = toolNode(tool({ status: "running", args: JSON.stringify({ command: "sleep 9" }), output: "1\n2\n", at: 1000 }), "/w", () => 4200);
    expect(node.props).toMatchObject({ status: "running", age: 4200, collapsed: false, preview: { tail: 4 } });
    expect(node.children[0]?.props.follow).toBe(true);
  });

  it("draws an edit as a diff with its +/− counts", () => {
    const node = toolNode(
      tool({ name: "edit", category: "edit", paths: ["/w/src/a.ts"], diffStat: { added: 1, removed: 1 }, diff: { added: 1, removed: 1, lines: [{ kind: "del", text: "a", line: 3 }, { kind: "add", text: "b", line: 3 }] } }),
      "/w",
      () => undefined,
    );
    expect(node.props).toMatchObject({ title: "Update", target: "src/a.ts", targetKind: "path", meta: ["+1", "−1"] });
    expect(node.children[0]?.kind).toBe("diff");
    expect(String(node.children[0]?.props.text)).toContain("-a\n+b");
  });

  it("draws what a compaction kept as plain rows with its reply, not a fold", () => {
    const items: ChatItem[] = [
      { kind: "notice", id: "n1", level: "info", text: "Earlier conversation was compacted" },
      { kind: "assistant", id: "a1", text: "The build passes now.\n\n- one\n- two", thinking: "", streaming: false },
    ];
    const chat = { chatId: "c", workspace: { id: "w", path: "/w", name: "w" }, status: "idle", items, capabilities: {}, checkpoints: [] } as unknown as ChatState;
    const noop = () => undefined;
    const cx: ConversationCx = { chat, harness: null, webUrl: "http://x", age: () => undefined, shown: 30, folds: new Map(), picked: null, blob: () => null, on: { fold: noop, pick: noop, showEarlier: noop, retry: noop, edit: noop, fork: noop, undo: noop, copy: noop } };
    const [turn] = conversation(cx);
    const kinds = (n: Node): string[] => [n.kind, ...n.children.flatMap(kinds)];
    expect(kinds(turn as Node)).not.toContain("section");
    expect(JSON.stringify(turn)).toContain("Earlier conversation was compacted");
    expect(JSON.stringify(turn)).toContain("The build passes now.");
  });

  it("words a fold the web UI's way", () => {
    const turn = { live: false, startedAt: 0, endedAt: 27_000 } as Turn;
    const seg = { counts: { command: 3 } } as unknown as WorkSegment;
    expect(foldHead(turn, seg, "only")).toBe("Worked for 27s · 3 commands");
    expect(foldHead(turn, seg, "last")).toBe("3 commands");
    expect(foldHead({ ...turn, live: true }, seg, "only")).toBe("Working · 3 commands");
  });
});

describe("awui tern's command line", () => {
  it("takes atui's options", () => {
    expect(parseTernArgs(["--url", "http://h:1/", "--harness", "pi", "--resume"], {})).toMatchObject({ url: "http://h:1", harness: "pi", resume: true });
    expect(parseTernArgs(["--vim"], {})).toEqual({ error: "Unknown option --vim" });
    expect(parseTernArgs(["-h"], {})).toEqual({ help: true });
  });

  it("finds the client in the checkout, else where `awui install tui` put it", () => {
    expect(ternEntry("/nowhere", false)).toMatch(/src\/tern\/main\.ts$/);
    const state = mkdtempSync(path.join(tmpdir(), "awui-tern-"));
    // A binary somewhere with no checkout above it, before and after install tui.
    expect(ternEntry(state, true, "/usr/bin/env")).toBeNull();
    mkdirSync(path.join(state, "atui", "src", "tern"), { recursive: true });
    writeFileSync(path.join(state, "atui", "src", "tern", "main.ts"), "");
    expect(ternEntry(state, true, "/usr/bin/env")).toBe(path.join(state, "atui", "src", "tern", "main.ts"));
    // A binary built into a checkout's dist/bin (install service --link) runs the checkout's client.
    const bin = path.join(process.cwd(), "dist", "bin", "linux-x64", "awui");
    expect(ternEntry(state, true, bin)).toBe(path.join(process.cwd(), "src", "tern", "main.ts"));
  });
});
