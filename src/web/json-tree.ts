// A JSON value as the rows of a collapsible tree, for a tool's arguments and
// for an output that parses as JSON (MCP tools most of all). Pure: it walks
// the value once, skips what a fold hides, and stops at a node cap, so the
// component only draws rows. Text is only ever text here, never markup.

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonRow {
  depth: number;
  /** The property name or array index; null for the root. */
  key: string | null;
  kind: JsonKind;
  /** A leaf's text as shown (a string cut at STRING_CUT, quotes included); a container's count, "{3}" or "[12]". */
  preview: string;
  /** Where the row sits ("a.0.b", dots in keys escaped): what a fold or a long string is remembered by. */
  path: string;
  /** Containers only: whether its children follow. */
  open: boolean;
  /** Strings only: the text was cut, and "…more" shows the rest. */
  more: boolean;
  /** Containers only: it has children to fold. */
  foldable: boolean;
}

export interface JsonRows {
  rows: JsonRow[];
  /** The cap was reached; later nodes are not listed. */
  capped: boolean;
}

export const MAX_NODES = 2000;
export const STRING_CUT = 200;
/** Containers this deep or deeper start folded. */
export const OPEN_DEPTH = 2;

/** The value when the text is a JSON object or array; null for anything else (plain text, a bare number, bad JSON). */
export function parseJsonContainer(text: string): object | null {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    const value: unknown = JSON.parse(t);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const escapeKey = (key: string) => key.replace(/\\/g, "\\\\").replace(/\./g, "\\.");

/**
 * The rows to draw. `toggled` holds the paths whose fold differs from the
 * default (open above OPEN_DEPTH); `whole` holds the strings shown uncut.
 */
export function flattenJson(value: unknown, toggled: ReadonlySet<string> = new Set(), whole: ReadonlySet<string> = new Set()): JsonRows {
  const rows: JsonRow[] = [];
  let capped = false;
  const walk = (v: unknown, key: string | null, path: string, depth: number): void => {
    if (rows.length >= MAX_NODES) {
      capped = true;
      return;
    }
    if (v !== null && typeof v === "object") {
      const array = Array.isArray(v);
      const entries: Array<[string, unknown]> = array ? v.map((x, i) => [String(i), x]) : Object.entries(v);
      const open = depth < OPEN_DEPTH !== toggled.has(path);
      rows.push({ depth, key, kind: array ? "array" : "object", preview: array ? `[${entries.length}]` : `{${entries.length}}`, path, open, more: false, foldable: entries.length > 0 });
      if (open) for (const [k, child] of entries) walk(child, k, path === "" ? escapeKey(k) : `${path}.${escapeKey(k)}`, depth + 1);
      return;
    }
    if (typeof v === "string") {
      const cut = v.length > STRING_CUT && !whole.has(path);
      // A cut string drops its closing quote, so the "…more" reads as the rest of it.
      const preview = cut ? JSON.stringify(v.slice(0, STRING_CUT)).slice(0, -1) : JSON.stringify(v);
      rows.push({ depth, key, kind: "string", preview, path, open: false, more: cut, foldable: false });
      return;
    }
    const kind: JsonKind = typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "null";
    rows.push({ depth, key, kind, preview: String(v ?? "null"), path, open: false, more: false, foldable: false });
  };
  walk(value, null, "", 0);
  return { rows, capped };
}
