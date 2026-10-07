import { describe, expect, it } from "vitest";
import { rankItems, type PaletteItem } from "../../src/web/palette.js";

const item = (id: string, section: string, label: string, more: Partial<PaletteItem> = {}): PaletteItem => ({ id, section, label, run: () => {}, ...more });

const items = [
  item("new", "Actions", "New chat"),
  item("compact", "Actions", "Compact context"),
  item("s1", "Sessions", "Fix the waybar", { hint: "dotfiles", keywords: "omp" }),
  item("s2", "Sessions", "Old idea", { searchOnly: true, hint: "notes" }),
  item("m1", "Model", "Claude Opus 5.5", { hint: "anthropic", keywords: "anthropic/opus-5-5", searchOnly: true }),
  item("t1", "Theme", "Theme: Dark", { searchOnly: true }),
];

const ids = (q: string) => rankItems(items, q).map((i) => i.id);

describe("command palette ranking", () => {
  it("lists everything but search-only items before anything is typed", () => {
    expect(ids("")).toEqual(["new", "compact", "s1"]);
  });

  it("puts label prefixes first, then word starts, then the rest", () => {
    expect(ids("c")).toEqual(["compact", "m1", "new"]);
    expect(ids("chat")).toEqual(["new"]);
  });

  it("matches hints, keywords, and section names, ignoring punctuation", () => {
    expect(ids("dotfiles")).toEqual(["s1"]);
    expect(ids("opus55")).toEqual(["m1"]);
    expect(ids("model anthropic")).toEqual(["m1"]);
    expect(ids("theme dark")).toEqual(["t1"]);
    expect(ids("old")).toEqual(["s2"]);
    expect(ids("zzz")).toEqual([]);
  });
});
