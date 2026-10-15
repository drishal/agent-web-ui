// What atui changes in Markdown before OpenTUI draws it: task-list boxes as
// ☐/☑ (the terminal has no checkbox), outside code, the cursor at the end of
// text still streaming, and the language a path's extension names, for
// highlighting a diff's lines.

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Where streamed text is being written. */
export const CARET = "▍";

/**
 * Text still streaming with the cursor after it, unless its last line is one
 * a character would change the meaning of: a code fence (it would become the
 * language), a table row, or a rule. There the cursor waits a moment, until
 * the next line starts.
 */
export function withCaret(markdown: string): string {
  const last = markdown.slice(markdown.lastIndexOf("\n") + 1);
  if (FENCE.test(last) || /^\s*\|/.test(last) || /^\s*([-*_=])(\s*\1){2,}\s*$/.test(last)) return markdown;
  return `${markdown}${CARET}`;
}

/** `- [ ] x` → `- ☐ x`, `- [x] x` → `- ☑ x`; code blocks are left alone. */
export function taskBoxes(markdown: string): string {
  if (!markdown.includes("[")) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const f = FENCE.exec(line)?.[1];
      if (f) {
        if (fence === null) fence = f[0] as string;
        else if (f[0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s)/, (_, lead: string, mark: string) => `${lead}${mark === " " ? "☐" : "☑"}`);
    })
    .join("\n");
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  zig: "zig",
  sh: "bash",
  bash: "bash",
  css: "css",
  html: "html",
  nix: "nix",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  c: "c",
  h: "c",
  cpp: "cpp",
  java: "java",
  rb: "ruby",
  lua: "lua",
};

/** The tree-sitter language for a file, from its extension; undefined when unknown. */
export function filetypeOf(file: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  return ext ? LANGUAGES[ext] : undefined;
}
