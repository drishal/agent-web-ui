// Text search across a project, for the web UI's "Search in project" (T3
// Code's): `git grep` over what git tracks and the untracked files it does not
// ignore, or, outside a repository, a scan of project-files' bounded walk.
// The query is always a fixed string (-F), never a pattern, so a search cannot
// be made to backtrack forever, and it goes after -e, so it is never an option.
// Results are bounded: so many matches in all, a few per file, and each line
// cut around its match.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectSearch, SearchMatch } from "../shared/protocol.js";
import { git } from "./git.js";
import { projectFiles } from "./project-files.js";

export const MAX_MATCHES = 300;
const PER_FILE = 20;
const LINE_CHARS = 240;
const SCAN_FILES = 4000;
const SCAN_FILE_BYTES = 512 * 1024;

/** The line cut to LINE_CHARS around the match's start, with … where it was cut. */
export function cutLine(line: string, at: number): string {
  const text = line.replace(/\t/g, "  ").trimEnd();
  if (text.length <= LINE_CHARS) return text.trimStart();
  const start = Math.max(0, Math.min(at - 60, text.length - LINE_CHARS));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + LINE_CHARS).trim()}${start + LINE_CHARS < text.length ? "…" : ""}`;
}

/** `git grep -n -z` output (path NUL line NUL text) into matches, at most PER_FILE per file. */
export function parseGrep(out: string, query: string, caseSensitive: boolean): ProjectSearch {
  const matches: SearchMatch[] = [];
  const perFile = new Map<string, number>();
  const needle = caseSensitive ? query : query.toLowerCase();
  let truncated = false;
  for (const row of out.split("\n")) {
    if (!row) continue;
    const [file, num, ...rest] = row.split("\0");
    const line = Number(num);
    if (!file || !Number.isInteger(line)) continue;
    const seen = perFile.get(file) ?? 0;
    if (seen >= PER_FILE) {
      truncated = true;
      continue;
    }
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    perFile.set(file, seen + 1);
    const text = rest.join("\0");
    matches.push({ path: file, line, text: cutLine(text, (caseSensitive ? text : text.toLowerCase()).indexOf(needle)) });
  }
  return { matches, truncated };
}

/** Outside git: read the walk's files (small, not binary) line by line. */
async function scan(root: string, query: string, caseSensitive: boolean): Promise<ProjectSearch> {
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  let truncated = false;
  const files = await projectFiles(root);
  if (files.length > SCAN_FILES) truncated = true;
  for (const file of files.slice(0, SCAN_FILES)) {
    const full = path.join(root, file);
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat?.isFile() || stat.size > SCAN_FILE_BYTES) continue;
    const bytes = await fs.readFile(full).catch(() => null);
    if (!bytes || bytes.subarray(0, 8000).includes(0)) continue;
    let inFile = 0;
    const lines = bytes.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const at = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
      if (at < 0) continue;
      if (inFile >= PER_FILE || matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      inFile++;
      matches.push({ path: file, line: i + 1, text: cutLine(line, at) });
    }
    if (matches.length >= MAX_MATCHES) break;
  }
  return { matches, truncated };
}

/** Lines of the project at `root` holding `query`. */
export async function searchProject(root: string, query: string, caseSensitive = false): Promise<ProjectSearch> {
  let out: string;
  try {
    out = await git(
      ["grep", "-n", "-z", "-I", "--no-color", "--untracked", "--exclude-standard", "-F", ...(caseSensitive ? [] : ["-i"]), "--max-count", String(PER_FILE + 1), "-e", query, "--", "."],
      // grep exits 1 when nothing matched: an answer, not a failure.
      { cwd: root, timeoutMs: 10_000, okExit: [1] },
    );
  } catch (error) {
    if (/not a git repository/i.test(error instanceof Error ? error.message : "")) return scan(root, query, caseSensitive);
    throw error;
  }
  return parseGrep(out, query, caseSensitive);
}
