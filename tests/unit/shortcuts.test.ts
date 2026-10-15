import { describe, expect, it } from "vitest";
import { balanceColumns, filterShortcuts, isShortcutsKey, keyCaps, keyHint, SHORTCUTS, shortcutHint } from "../../src/web/shortcuts.js";

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}, inBox = false) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
  target: { closest: () => (inBox ? {} : null) } as unknown as EventTarget,
});

describe("keyboard shortcuts", () => {
  it("writes keys for the platform: Ctrl and Alt, or ⌘ and ⌥", () => {
    expect(keyCaps("Mod+Shift+F", false)).toEqual(["Ctrl", "Shift", "F"]);
    expect(keyCaps("Mod+Shift+F", true)).toEqual(["⌘", "⇧", "F"]);
    expect(keyHint("Alt+Shift+T", false)).toBe("Alt+Shift+T");
    expect(keyHint("Alt+Shift+T", true)).toBe("⌥⇧T");
    expect(keyCaps("+", false)).toEqual(["+"]);
  });

  it("gives the palette its hints from the same table", () => {
    expect(shortcutHint("search", false)).toBe("Ctrl+Shift+F");
    expect(shortcutHint("palette", true)).toBe("⌘K");
    expect(shortcutHint("nothing", false)).toBe("");
    const ids = SHORTCUTS.flatMap((g) => g.items.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("narrows to the shortcuts whose words or keys match", () => {
    const stash = filterShortcuts("stash", false);
    expect(stash).toHaveLength(1);
    expect(stash[0]?.items.map((s) => s.id)).toEqual(["stash"]);
    expect(filterShortcuts("ctrl+shift+f", false).flatMap((g) => g.items.map((s) => s.id))).toContain("search");
    expect(filterShortcuts("zzz", false)).toEqual([]);
    expect(filterShortcuts("", false)).toBe(SHORTCUTS);
  });

  it("splits the groups into two stacks of about the same height, in order", () => {
    const [left, right] = balanceColumns(SHORTCUTS);
    expect([...left, ...right]).toEqual(SHORTCUTS);
    const rows = (gs: typeof SHORTCUTS) => gs.reduce((n, g) => n + g.items.length + 2, 0);
    expect(Math.abs(rows(left) - rows(right))).toBeLessThanOrEqual(Math.max(...SHORTCUTS.map((g) => g.items.length + 2)));
    const one = filterShortcuts("stash", false);
    expect(balanceColumns(one)).toEqual([one, []]);
  });

  it("opens on ? outside a text box, and on Mod+/ anywhere", () => {
    expect(isShortcutsKey(key("?"))).toBe(true);
    expect(isShortcutsKey(key("?", {}, true))).toBe(false);
    expect(isShortcutsKey(key("/", { ctrl: true }, true))).toBe(true);
    expect(isShortcutsKey(key("/", { meta: true }))).toBe(true);
    expect(isShortcutsKey(key("?", { ctrl: true }))).toBe(false);
    expect(isShortcutsKey(key("/"))).toBe(false);
  });
});
