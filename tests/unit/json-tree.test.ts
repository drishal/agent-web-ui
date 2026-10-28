import { describe, expect, it } from "vitest";
import { flattenJson, MAX_NODES, parseJsonContainer, STRING_CUT } from "../../src/web/json-tree.js";

describe("parseJsonContainer", () => {
  it("takes objects and arrays only", () => {
    expect(parseJsonContainer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContainer(" [1,2] ")).toEqual([1, 2]);
    expect(parseJsonContainer("12")).toBeNull();
    expect(parseJsonContainer('"x"')).toBeNull();
    expect(parseJsonContainer("not json")).toBeNull();
    expect(parseJsonContainer("{broken")).toBeNull();
  });
});

describe("flattenJson", () => {
  const value = { name: "x", n: 3, ok: true, none: null, list: [1, { deep: { deeper: { deepest: 1 } } }] };

  it("lists nested rows with kinds, counts, and depth", () => {
    const { rows } = flattenJson(value);
    expect(rows[0]).toMatchObject({ depth: 0, key: null, kind: "object", preview: "{5}", open: true });
    expect(rows.find((r) => r.key === "name")).toMatchObject({ kind: "string", preview: '"x"', depth: 1 });
    expect(rows.find((r) => r.key === "n")).toMatchObject({ kind: "number", preview: "3" });
    expect(rows.find((r) => r.key === "ok")).toMatchObject({ kind: "boolean", preview: "true" });
    expect(rows.find((r) => r.key === "none")).toMatchObject({ kind: "null", preview: "null" });
    expect(rows.find((r) => r.key === "list")).toMatchObject({ kind: "array", preview: "[2]", path: "list" });
  });

  it("opens two levels and folds the rest", () => {
    const { rows } = flattenJson(value);
    expect(rows.find((r) => r.path === "list.1")).toMatchObject({ open: false, preview: "{1}" });
    expect(rows.find((r) => r.key === "deep")).toBeUndefined();
  });

  it("toggles a fold by path, both ways", () => {
    expect(flattenJson(value, new Set(["list.1"])).rows.find((r) => r.key === "deep")).toBeDefined();
    expect(flattenJson(value, new Set(["list"])).rows.find((r) => r.key === "1")).toBeUndefined();
  });

  it("cuts long strings and shows them whole on request", () => {
    const long = "a".repeat(STRING_CUT + 50);
    const cut = flattenJson({ s: long }).rows[1]!;
    expect(cut.more).toBe(true);
    expect(cut.preview).toBe(`"${"a".repeat(STRING_CUT)}`);
    const full = flattenJson({ s: long }, new Set(), new Set(["s"])).rows[1]!;
    expect(full.more).toBe(false);
    expect(full.preview).toBe(JSON.stringify(long));
  });

  it("stops at the node cap", () => {
    const { rows, capped } = flattenJson(Array.from({ length: MAX_NODES + 50 }, (_, i) => i));
    expect(rows).toHaveLength(MAX_NODES);
    expect(capped).toBe(true);
    expect(flattenJson([1, 2]).capped).toBe(false);
  });

  it("does not offer a fold on an empty container", () => {
    expect(flattenJson({ a: [] }).rows[1]).toMatchObject({ preview: "[0]", foldable: false });
  });

  it("keeps keys with dots apart", () => {
    const { rows } = flattenJson({ "a.b": 1, a: { b: 2 } });
    const paths = rows.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
