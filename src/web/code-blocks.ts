// What a code block in an answer needs worked out: whether it can be run (one command line in a shell the server knows),
// its header's language name, which colours it gets, and when it is long enough for line numbers.
import { RUN_SHELLS, type RunShell } from "../shared/protocol.js";
import { languageOf } from "./highlight.js";

const SHELL_OF: Record<string, RunShell> = { bash: "bash", sh: "sh", shell: "sh", shellscript: "sh", console: "sh", zsh: "zsh", fish: "fish" };

/** The shell to run a block with, or null when it is not a one-line shell block. */
export function runnable(lang: string | null, code: string): { shell: RunShell; command: string } | null {
  const shell = lang ? SHELL_OF[lang.toLowerCase()] : undefined;
  if (!shell || !(RUN_SHELLS as readonly string[]).includes(shell)) return null;
  const command = code.trim().replace(/^\$\s+/, "");
  if (!command || command.includes("\n")) return null;
  return { shell, command };
}

const LABELS: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JSX",
  ts: "TypeScript", typescript: "TypeScript", mts: "TypeScript", cts: "TypeScript", tsx: "TSX",
  json: "JSON", jsonc: "JSONC", json5: "JSON5", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI", xml: "XML", html: "HTML", css: "CSS", scss: "SCSS", less: "Less", sql: "SQL",
  py: "Python", python: "Python", rs: "Rust", rust: "Rust", go: "Go", golang: "Go", rb: "Ruby", ruby: "Ruby", lua: "Lua", php: "PHP", nix: "Nix",
  c: "C", cpp: "C++", "c++": "C++", cs: "C#", csharp: "C#", "c#": "C#", java: "Java", kt: "Kotlin", kotlin: "Kotlin", swift: "Swift", scala: "Scala", dart: "Dart", zig: "Zig",
  md: "Markdown", markdown: "Markdown", diff: "Diff", dockerfile: "Dockerfile", makefile: "Makefile", graphql: "GraphQL",
};

/**
 * What the block's header calls its language: a known one in its usual casing ("TypeScript", "JSON"), anything else (and every shell, which
 * people name in lower case: bash, zsh) as the fence wrote it; null for an unlabeled block.
 */
export function languageLabel(lang: string | null): string | null {
  const name = lang?.trim();
  if (!name) return null;
  return LABELS[name.toLowerCase()] ?? name;
}

/** Fence names that are not an extension highlight.ts knows (its `languageOf` reads a file name). */
const FENCE_EXT: Record<string, string> = {
  javascript: "js", typescript: "ts", python: "py", rust: "rs", ruby: "rb", golang: "go", shell: "sh", shellscript: "sh", console: "sh", terminal: "sh",
  "c++": "cpp", "c#": "cs", csharp: "cs", kotlin: "kt", markdown: "md", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
};

/** The highlight.ts language for a fence's name, or null when it has none (the block stays plain). */
export function highlightLanguage(lang: string | null): string | null {
  const name = lang?.trim().toLowerCase();
  if (!name) return null;
  return languageOf(`x.${FENCE_EXT[name] ?? name}`);
}

/** A block past either bound is drawn plain and without numbers: tokens and a node per line would cost more than they show. */
export const MAX_RICH_LINES = 2000;
export const MAX_RICH_BYTES = 100_000;

/** Whether a block is small enough for colours and line numbers. */
export function richBlock(code: string): boolean {
  return code.length <= MAX_RICH_BYTES && code.replace(/\n$/, "").split("\n").length <= MAX_RICH_LINES;
}

/** A block this long (in lines) gets a gutter of line numbers. */
export const NUMBERED_FROM = 6;

/** The gutter's width in digits for a block of `count` lines. */
export function gutterDigits(count: number): number {
  return String(Math.max(count, 1)).length;
}
