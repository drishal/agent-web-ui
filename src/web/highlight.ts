// Syntax colours for the file viewer, without a dependency: a small tokenizer
// that knows each common language's comments, strings, numbers, keywords, and
// literals (and a YAML or TOML key, a Markdown heading), carrying a block
// comment or a multi-line string from one line to the next. It colours; it
// does not parse, so an odd construct reads as plain text rather than wrong.

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "literal" | "type" | "key" | "heading";

export interface Token {
  kind: TokenKind;
  text: string;
}

interface Lang {
  /** Line comments. */
  line: string[];
  /** Block comments, open and close. */
  block: Array<[string, string]>;
  /** Quotes for one-line strings. */
  quotes: string[];
  /** Delimiters of strings that may run across lines (a backtick, a triple quote). */
  multi: string[];
  keywords: ReadonlySet<string>;
  literals: ReadonlySet<string>;
  /** A capitalised word is a type (C-family, Rust, Go, TypeScript). */
  types: boolean;
  /** A `key:` or `key =` at the start of a line is a key. */
  keys?: "yaml" | "toml";
  markdown?: boolean;
  /** A word may hold a dash (CSS properties, shell flags, Nix attributes). */
  dash?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS = words(
  "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
);
const PY = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield self");
const RS = words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while");
const GO = words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const SH = words("if then else elif fi case esac for while until do done in function select time return exit local export readonly declare set unset source alias eval exec shift trap");
const NIX = words("let in with rec inherit if then else assert import or");
const C = words(
  "auto break case char class const constexpr continue default delete do double else enum explicit extern float for friend goto if inline int long namespace new operator private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while final override package import extends implements interface fun val var when object companion data sealed func guard let struct protocol extension",
);
const SQL = words(
  "select from where insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as and or not in is like between distinct union all case when then else end with returning",
);
const LUA = words("and break do else elseif end for function goto if in local not or repeat return then until while");
const RB = words("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require");
const CSS = words("important media import supports keyframes font-face from to");

const COMMON_LITERALS = words("true false null undefined None True False nil NaN Infinity");

const C_LIKE = { line: ["//"], block: [["/*", "*/"]] as Array<[string, string]>, quotes: ['"', "'"], multi: [] as string[], literals: COMMON_LITERALS, types: true };

const LANGS: Record<string, Lang> = {
  js: { ...C_LIKE, multi: ["`"], keywords: JS },
  json: { line: [], block: [], quotes: ['"'], multi: [], keywords: words(""), literals: COMMON_LITERALS, types: false },
  py: { line: ["#"], block: [], quotes: ['"', "'"], multi: ['"""', "'''"], keywords: PY, literals: COMMON_LITERALS, types: true },
  rs: { ...C_LIKE, keywords: RS },
  go: { ...C_LIKE, multi: ["`"], keywords: GO },
  c: { ...C_LIKE, keywords: C },
  sh: { line: ["#"], block: [], quotes: ['"', "'"], multi: [], keywords: SH, literals: COMMON_LITERALS, types: false, dash: true },
  nix: { line: ["#"], block: [["/*", "*/"]], quotes: ['"'], multi: ["''"], keywords: NIX, literals: COMMON_LITERALS, types: false, dash: true },
  yaml: { line: ["#"], block: [], quotes: ['"', "'"], multi: [], keywords: words(""), literals: words("true false null yes no on off ~"), types: false, keys: "yaml", dash: true },
  toml: { line: ["#"], block: [], quotes: ['"', "'"], multi: ['"""', "'''"], keywords: words(""), literals: COMMON_LITERALS, types: false, keys: "toml" },
  css: { line: [], block: [["/*", "*/"]], quotes: ['"', "'"], multi: [], keywords: CSS, literals: words(""), types: false, dash: true },
  html: { line: [], block: [["<!--", "-->"]], quotes: ['"', "'"], multi: [], keywords: words(""), literals: words(""), types: false, dash: true },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: ["'", '"'], multi: [], keywords: SQL, literals: words("true false null"), types: false },
  lua: { line: ["--"], block: [["--[[", "]]"]], quotes: ['"', "'"], multi: [], keywords: LUA, literals: words("true false nil"), types: false },
  rb: { line: ["#"], block: [], quotes: ['"', "'"], multi: [], keywords: RB, literals: words("true false nil"), types: true },
  md: { line: [], block: [], quotes: [], multi: [], keywords: words(""), literals: words(""), types: false, markdown: true },
};

const EXT: Record<string, string> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  json: "json", jsonc: "js", json5: "js", lock: "json",
  py: "py", pyi: "py",
  rs: "rs", go: "go",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cxx: "c", java: "c", kt: "c", kts: "c", swift: "c", cs: "c", scala: "c", dart: "c", zig: "c",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", envrc: "sh",
  nix: "nix",
  yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "toml", conf: "toml", cfg: "toml",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
  sql: "sql", lua: "lua", rb: "rb",
  md: "md", markdown: "md", mdx: "md",
};

const NAMES: Record<string, string> = { Makefile: "sh", Dockerfile: "sh", Justfile: "sh", ".bashrc": "sh", ".zshrc": "sh", "flake.lock": "json" };

/** The language a path's name or extension says, for its colours; null for plain text. */
export function languageOf(file: string): string | null {
  const name = file.split("/").pop() ?? file;
  if (NAMES[name]) return NAMES[name] ?? null;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? (EXT[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** Where a string that opened with `quote` closes in `line` from `from` (past its closing quote), honouring backslashes; -1 when it does not. */
function closeOf(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\" && quote !== "''") {
      i++;
      continue;
    }
    if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/;
const WORD = /^[A-Za-z_$@][\w$]*/;
const DASH_WORD = /^[A-Za-z_$@-][\w$-]*/;

/** Each line of `text` as coloured tokens, in `lang` (languageOf's name), the state carried from line to line. */
export function highlightLines(text: string, lang: string | null): Token[][] {
  const spec = lang ? LANGS[lang] : undefined;
  const lines = text.split("\n");
  if (!spec) return lines.map((l) => [{ kind: "plain", text: l }]);
  /** What the line before left open: a block comment's close, or a multi-line string's quote. */
  let open: { kind: "comment" | "string"; close: string } | null = null;
  let fence = false;
  return lines.map((line) => {
    const out: Token[] = [];
    const push = (kind: TokenKind, value: string) => {
      if (!value) return;
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.text += value;
      else out.push({ kind, text: value });
    };
    if (spec.markdown) {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        push("comment", line);
      } else if (fence) push("string", line);
      else if (/^#{1,6}\s/.test(line)) push("heading", line);
      else for (const [i, part] of line.split(/(`[^`]*`)/).entries()) push(i % 2 === 1 ? "string" : "plain", part);
      return out.length > 0 ? out : [{ kind: "plain", text: "" }];
    }
    let i = 0;
    if (spec.keys && !open) {
      const key = (spec.keys === "yaml" ? /^(\s*-?\s*)([\w.$/@-]+|"[^"]*"|'[^']*')(\s*:)(?=\s|$)/ : /^(\s*)([\w.-]+|"[^"]*")(\s*=)/).exec(line);
      if (key) {
        push("plain", key[1] ?? "");
        push("key", key[2] ?? "");
        push("plain", key[3] ?? "");
        i = key[0].length;
      }
    }
    while (i < line.length) {
      if (open) {
        const end = open.kind === "string" ? closeOf(line, i, open.close) : line.indexOf(open.close, i);
        const stop = end < 0 ? line.length : open.kind === "string" ? end : end + open.close.length;
        push(open.kind, line.slice(i, stop));
        i = stop;
        if (end >= 0) open = null;
        continue;
      }
      const rest = line.slice(i);
      if (spec.line.some((c) => rest.startsWith(c)) && !(spec.keys === "yaml" && i > 0 && line[i - 1] !== " ")) {
        push("comment", rest);
        break;
      }
      const block = spec.block.find(([o]) => rest.startsWith(o));
      if (block) {
        push("comment", block[0]);
        i += block[0].length;
        open = { kind: "comment", close: block[1] };
        continue;
      }
      const multi = spec.multi.find((q) => rest.startsWith(q));
      if (multi) {
        push("string", multi);
        i += multi.length;
        open = { kind: "string", close: multi };
        continue;
      }
      const quote = spec.quotes.find((q) => rest.startsWith(q));
      // A shell or a prose apostrophe ("don't") is not a string; elsewhere a quote opens one.
      if (quote && !(quote === "'" && /\w/.test(line[i - 1] ?? "") && lang !== "sh")) {
        const end = closeOf(line, i + 1, quote);
        const stop = end < 0 ? line.length : end;
        push("string", line.slice(i, stop));
        i = stop;
        continue;
      }
      const before = line[i - 1] ?? "";
      if (!/[\w$.]/.test(before)) {
        const number = NUMBER.exec(rest);
        if (number) {
          push("number", number[0]);
          i += number[0].length;
          continue;
        }
        const word = (spec.dash ? DASH_WORD : WORD).exec(rest);
        if (word) {
          const w = word[0];
          push(spec.keywords.has(w) ? "keyword" : spec.literals.has(w) ? "literal" : spec.types && /^[A-Z][a-z0-9]/.test(w) ? "type" : "plain", w);
          i += w.length;
          continue;
        }
      }
      push("plain", line[i] as string);
      i += 1;
    }
    return out.length > 0 ? out : [{ kind: "plain", text: "" }];
  });
}
