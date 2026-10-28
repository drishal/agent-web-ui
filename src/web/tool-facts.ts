// Facts read from a tool call's output: "12 passed · 1 failed" for a test run,
// "3 errors in 2 files" for tsc, "4 results in 2 files" for rg, "added 12 packages"
// for npm. Each parser is small, deterministic, and claims an output only when
// it is sure of the shape (a log that merely mentions "passed" is nobody's);
// anything else returns nothing, and the row shows just its time. Parsers read
// the output as the item holds it (already cut to head and tail, 16 KB) and stop
// after MAX_LINES lines. Pure: atui and the Tern client may import it like turns.ts.
import type { ToolItem } from "../shared/protocol.js";

/** One structured line of a richer body: a search hit, a compiler error, a changed file. */
export interface FactRow {
  file?: string;
  line?: number;
  text: string;
}

export interface ToolFacts {
  kind?: "test" | "build" | "typecheck" | "git" | "search" | "listing" | "install" | "json";
  /** What the output says, shortest first: ["12 passed", "1 failed"]. */
  facts: string[];
  /** The first failing test, the first compiler error. */
  error?: string;
  rows?: FactRow[];
}

const MAX_LINES = 600;
const MAX_ROWS = 50;
const NONE: ToolFacts = { facts: [] };

type Args = Record<string, unknown>;

/** A call's arguments as an object; empty when they do not parse. */
export function toolArgs(raw: string): Args {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Args) : {};
  } catch {
    return {};
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function cut(text: string, max = 140): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function count(line: string, word: string): number {
  const m = new RegExp(`(\\d+) ${word}\\b`).exec(line);
  return m ? Number(m[1]) : 0;
}

/** "12 passed", "1 failed", "2 skipped": the nonzero parts, passed first. */
function tally(passed: number, failed: number, skipped: number): string[] {
  const out: string[] = [];
  if (passed > 0) out.push(`${passed} passed`);
  if (failed > 0) out.push(`${failed} failed`);
  if (skipped > 0) out.push(`${skipped} skipped`);
  return out;
}

/** Vitest's `Tests  1 failed | 25 passed (26)` and Jest's `Tests:  1 failed, 25 passed, 26 total`. */
function jsTests(lines: string[]): ToolFacts | undefined {
  const summary = lines.find((l) => /^\s*Tests:?\s+.*(?:\(\d+\)|\d+ total)\s*$/.test(l));
  if (!summary) return undefined;
  const passed = count(summary, "passed");
  const failed = count(summary, "failed");
  const skipped = count(summary, "skipped") + count(summary, "todo");
  if (passed + failed + skipped === 0) return undefined;
  // The first failing test: Vitest's `FAIL  file > name` or Jest's `● suite › name`.
  let error: string | undefined;
  for (const l of lines) {
    const vitest = /^\s*FAIL\s+\S+\s+>\s+(.+)$/.exec(l);
    const jest = /^\s*●\s+(.+?)\s*$/.exec(l);
    const name = vitest ? (vitest[1] as string).split(" > ").pop() : jest ? (jest[1] as string).split(" › ").pop() : undefined;
    if (name && !/^Console\b/.test(name)) {
      error = cut(name);
      break;
    }
  }
  return { kind: "test", facts: tally(passed, failed, skipped), ...(error ? { error } : {}) };
}

/** pytest's `===== 1 failed, 2 passed in 0.12s =====`. */
function pytest(lines: string[]): ToolFacts | undefined {
  const summary = [...lines].reverse().find((l) => /^=+ .+ in [\d.]+s(?: \(.*\))? =+$/.test(l));
  if (!summary) return undefined;
  const passed = count(summary, "passed");
  const failed = count(summary, "failed") + count(summary, "errors?");
  const skipped = count(summary, "skipped");
  if (passed + failed + skipped === 0) return undefined;
  const failure = lines.find((l) => /^(?:FAILED|ERROR) \S+/.test(l));
  return { kind: "test", facts: tally(passed, failed, skipped), ...(failure ? { error: cut(failure.replace(/^(?:FAILED|ERROR) /, "")) } : {}) };
}

/** cargo test's `test result: FAILED. 3 passed; 1 failed; ...` (one per test binary) and go test's `--- FAIL:` and `ok  pkg` lines. */
function cargoOrGo(lines: string[]): ToolFacts | undefined {
  const results = lines.filter((l) => /^test result: (?:ok|FAILED)\./.test(l));
  if (results.length > 0) {
    let passed = 0;
    let failed = 0;
    let ignored = 0;
    for (const l of results) {
      passed += count(l, "passed");
      failed += count(l, "failed");
      ignored += count(l, "ignored");
    }
    const fail = lines.find((l) => /^test .+ \.\.\. FAILED$/.test(l));
    const name = fail ? /^test (.+) \.\.\. FAILED$/.exec(fail)?.[1] : undefined;
    return { kind: "test", facts: tally(passed, failed, ignored), ...(name ? { error: cut(name) } : {}) };
  }
  const verbose = lines.filter((l) => /^\s*--- (?:PASS|FAIL):/.test(l));
  const packages = lines.filter((l) => /^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/.test(l));
  if (verbose.length > 0 || packages.length > 0) {
    const fail = lines.find((l) => /^\s*--- FAIL: \S+/.test(l));
    const name = fail ? /--- FAIL: (\S+)/.exec(fail)?.[1] : undefined;
    const error = name ? { error: cut(name) } : {};
    if (verbose.length > 0) {
      const failed = verbose.filter((l) => /--- FAIL:/.test(l)).length;
      return { kind: "test", facts: tally(verbose.length - failed, failed, 0), ...error };
    }
    const failed = packages.filter((l) => l.startsWith("FAIL")).length;
    const ok = packages.length - failed;
    return { kind: "test", facts: [...(ok > 0 ? [`${plural(ok, "package")} ok`] : []), ...(failed > 0 ? [`${failed} failed`] : [])], ...error };
  }
  return undefined;
}

/** tsc's `file(line,col): error TS…` (or the pretty `file:line:col - error TS…`) and eslint's stylish report. */
function compiler(lines: string[]): ToolFacts | undefined {
  const rows: FactRow[] = [];
  const files = new Set<string>();
  let errors = 0;
  for (const l of lines) {
    const m = /^(\S[^()]*?)(?:\((\d+),\d+\): |:(\d+):\d+ - )error (TS\d+): (.*)$/.exec(l);
    if (!m) continue;
    errors++;
    files.add(m[1] as string);
    if (rows.length < MAX_ROWS) rows.push({ file: m[1] as string, line: Number(m[2] ?? m[3]), text: `${m[4]}: ${m[5]}` });
  }
  if (errors > 0) {
    const first = rows[0];
    return {
      kind: "typecheck",
      facts: [`${plural(errors, "error")} in ${plural(files.size, "file")}`],
      ...(first?.file ? { error: cut(`${first.file}:${first.line}: ${first.text}`) } : {}),
      rows,
    };
  }
  // eslint: a path line, then `  12:5  error  message  rule`, and `✖ 3 problems (2 errors, 1 warning)`.
  const problems = lines.find((l) => /^\s*✖ \d+ problems? \(/.test(l));
  if (problems) {
    const e = count(problems, "errors?");
    const w = count(problems, "warnings?");
    let file = "";
    let first: string | undefined;
    for (const l of lines) {
      if (/^\/?[\w@./-]+\.[A-Za-z]+$/.test(l.trim()) && !/^\s+\d+:\d+/.test(l)) file = l.trim();
      const m = /^\s+(\d+):\d+\s+error\s+(.+?)\s{2,}\S+\s*$/.exec(l);
      if (m && !first) first = cut(`${file}:${m[1]}: ${m[2]}`);
    }
    const facts = [e > 0 ? plural(e, "error") : "", w > 0 ? plural(w, "warning") : ""].filter(Boolean);
    return { kind: "build", facts, ...(first ? { error: first } : {}) };
  }
  return undefined;
}

/** `path:line:text` and `path:line:col:text` lines: grep -n, rg, and a search tool's output. Claimed only when nearly every line has the shape. */
function grepHits(lines: string[]): ToolFacts | undefined {
  const shaped = lines.filter((l) => l.trim());
  if (shaped.length === 0) return undefined;
  const hits: FactRow[] = [];
  const files = new Set<string>();
  for (const l of shaped) {
    const m = /^(\S[^:\n]*?):(\d+)(?::\d+)?:(.*)$/.exec(l);
    if (!m || /\s-\s/.test(m[1] as string)) continue;
    files.add(m[1] as string);
    if (hits.length < MAX_ROWS) hits.push({ file: m[1] as string, line: Number(m[2]), text: (m[3] as string).trim() });
  }
  let matched = 0;
  for (const l of shaped) if (/^\S[^:\n]*?:\d+(?::\d+)?:/.test(l)) matched++;
  if (matched === 0 || matched < shaped.length * 0.8) return undefined;
  return { kind: "search", facts: [`${plural(matched, "result")} in ${plural(files.size, "file")}`], rows: hits };
}

/** `git status --short` / the long form (given the command, which tells porcelain from a listing) and `git diff --stat`'s last line. */
function git(lines: string[], command: string): ToolFacts | undefined {
  const stat = [...lines].reverse().find((l) => /^\s*\d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?\s*$/.test(l));
  if (stat) {
    const files = count(stat, "files?");
    const added = count(stat, "insertions?");
    const removed = count(stat, "deletions?");
    const change = [added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""].filter(Boolean).join(" ");
    const rows = lines.flatMap((l): FactRow[] => {
      const m = /^\s*(\S.*?)\s+\|\s+\d+/.exec(l);
      return m ? [{ file: m[1] as string, text: l.trim() }] : [];
    });
    return { kind: "git", facts: [plural(files, "file"), ...(change ? [change] : [])], rows: rows.slice(0, MAX_ROWS) };
  }
  if (!/\bgit\s+(?:-\S+\s+)*status\b/.test(command)) return undefined;
  let changed = 0;
  let added = 0;
  const rows: FactRow[] = [];
  const short = lines.filter((l) => l.trim());
  if (short.length > 0 && short.every((l) => /^[ MADRCU?!]{2} \S/.test(l) || /^## /.test(l))) {
    for (const l of short) {
      if (l.startsWith("##")) continue;
      const code = l.slice(0, 2);
      if (code === "??" || code.includes("A")) added++;
      else changed++;
      if (rows.length < MAX_ROWS) rows.push({ file: l.slice(3), text: l });
    }
  } else if (lines.some((l) => /^On branch |^HEAD detached/.test(l))) {
    let untracked = false;
    for (const l of lines) {
      if (/^Untracked files:/.test(l)) untracked = true;
      else if (/^\S/.test(l) && !l.startsWith("(")) untracked = false;
      const m = /^\t(modified|deleted|renamed|new file|typechange):\s+(.+)$/.exec(l);
      if (m) {
        if (m[1] === "new file") added++;
        else changed++;
        if (rows.length < MAX_ROWS) rows.push({ file: m[2] as string, text: l.trim() });
      } else if (untracked && /^\t\S/.test(l)) {
        added++;
        if (rows.length < MAX_ROWS) rows.push({ file: l.trim(), text: l.trim() });
      }
    }
    if (changed + added === 0) return { kind: "git", facts: ["clean"] };
  } else return undefined;
  if (changed + added === 0) return undefined;
  return { kind: "git", facts: [changed > 0 ? `${changed} changed` : "", added > 0 ? `${added} new` : ""].filter(Boolean), rows };
}

/** npm's "added 12 packages, and audited 13 packages in 2s", pnpm's "Packages: +12", pip's "Successfully installed a-1 b-2". */
function install(lines: string[]): ToolFacts | undefined {
  for (const l of lines) {
    const pip = /^Successfully installed (.+)$/.exec(l);
    if (pip) return { kind: "install", facts: [`installed ${plural((pip[1] as string).split(/\s+/).length, "package")}`] };
    if (/^(?:added|removed|changed) \d+ packages?\b/.test(l)) {
      const added = /added (\d+) packages?/.exec(l);
      const removed = /removed (\d+) packages?/.exec(l);
      const changed = /changed (\d+) packages?/.exec(l);
      const facts = [added ? `added ${plural(Number(added[1]), "package")}` : "", removed ? `removed ${plural(Number(removed[1]), "package")}` : "", changed ? `changed ${plural(Number(changed[1]), "package")}` : ""].filter(Boolean);
      return { kind: "install", facts };
    }
    if (/^up to date, audited \d+ packages?/.test(l)) return { kind: "install", facts: ["up to date"] };
    const pnpm = /^Packages: \+(\d+)/.exec(l);
    if (pnpm) return { kind: "install", facts: [`added ${plural(Number(pnpm[1]), "package")}`] };
  }
  return undefined;
}

/** An output that is one JSON array: "12 items". An object says nothing; what it holds is not a fact about the call. */
function json(output: string): ToolFacts | undefined {
  const t = output.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    return Array.isArray(parsed) ? { kind: "json", facts: [parsed.length === 0 ? "no items" : plural(parsed.length, "item")] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a finished call's output says, when a parser is sure of it; otherwise no
 * facts. A running call's output is partial, so it claims nothing.
 */
export function toolFacts(item: ToolItem): ToolFacts {
  if (item.status === "running" || !item.output.trim()) return NONE;
  const text = item.output.replace(ANSI, "");
  const lines = text.split("\n").slice(0, MAX_LINES);
  // A cut output (head, a gap, tail) keeps its summary at the tail, but its middle is missing: counts of lines are no longer true.
  const tail = item.truncated ? text.split("\n").slice(-200) : [];
  const seen = item.truncated ? [...lines.slice(0, 100), ...tail] : lines;
  const command = String(toolArgs(item.args).command ?? toolArgs(item.args).cmd ?? "");
  const category = item.category;
  if (category === "command" || category === "other" || category === "search") {
    if (category !== "search") {
      const found = jsTests(seen) ?? pytest(seen) ?? cargoOrGo(seen) ?? compiler(seen) ?? git(seen, command) ?? install(seen);
      if (found) return found;
    }
    // A truncated search lists only part of its hits: no count rather than a wrong one.
    if (!item.truncated) {
      const found = grepHits(lines) ?? json(text);
      if (found && (category !== "search" || found.kind === "search" || found.kind === "json")) return found;
    }
  }
  return NONE;
}
