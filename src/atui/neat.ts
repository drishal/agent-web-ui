// What a tool row says, the way neat-render (the pi extension in
// ~/.pi/agent/extensions) words it: a label and its target on the call line,
// then the outcome on a `└` line under it.
//
//   ● Read src/app.ts:1-20            ● Update(src/app.ts)
//     └ 20 lines                        └ Added 3 lines, removed 1 line
//                                         - const a = 1;
//   ● Bash $ npm test                     + const a = 2;
//     └ exit 2 · 14 lines
//
// Worked out apart from the drawing so it can be tested.
import type { ToolItem } from "../shared/protocol.js";
import { relativePath } from "../web/turns.js";

export interface NeatRow {
  label: string;
  detail?: string;
  /** Between label and detail: "" gives `Update(path)`. */
  glue: string;
  facts: string[];
  /** The model's own remark on a command (its leading `# comment` lines), shown dim above the call. */
  note?: string;
  /** An edit's first changed lines, under the outcome. */
  diff?: Array<{ marker: "+" | "-" | " "; text: string }>;
  /** Diff lines past the preview. */
  more?: number;
}

/** Diff lines shown under an edit before the rest is elided. */
export const DIFF_PREVIEW_LINES = 8;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function args(item: ToolItem): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(item.args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lineCount(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

/** A path relative to the project, `~` for home, and only its last three parts when it is deep. */
export function shortPath(p: string, workspace: string, home = process.env.HOME ?? ""): string {
  let out = relativePath(p, workspace);
  if (home && out.startsWith(`${home}/`)) out = `~${out.slice(home.length)}`;
  const parts = out.split("/");
  return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : out;
}

/**
 * A command's leading `# comment` lines, split off: models narrate inside the
 * command ("# check the config ⏎ rg -n …"), which would push the real command
 * off the row. A shebang is not a comment; a command of only comments stays.
 */
export function splitComments(cmd: string, marker = "#"): { note?: string; command: string } {
  const lines = cmd.split("\n");
  const notes: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = (lines[i] as string).trim();
    if (t === "" && notes.length > 0) continue;
    if (!t.startsWith(marker) || t.startsWith("#!")) break;
    const text = t.slice(marker.length).replace(/^[#/\s]*/, "");
    if (text) notes.push(text);
  }
  const command = lines.slice(i).join("\n").trim();
  if (!command || notes.length === 0) return { command: cmd };
  return { note: notes.join(" "), command };
}

/** "Added 35 lines, removed 2 lines": Claude Code's phrasing. */
function diffStat(added: number, removed: number): string | undefined {
  const parts: string[] = [];
  if (added) parts.push(`Added ${plural(added, "line")}`);
  if (removed) parts.push(`removed ${plural(removed, "line")}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/+$/, "");

export function neatRow(item: ToolItem, workspace: string): NeatRow {
  const a = args(item);
  const failed = item.status === "error";
  const running = item.status === "running";
  const lines = running ? 0 : lineCount(item.output);
  const path = item.paths[0] ?? str(a.path) ?? str(a.file_path);
  // A failure says so, unless an exit code already does.
  const outcome = (facts: string[]) => (failed && !facts.some((f) => /^(failed|exit \d)/.test(f)) ? ["failed", ...facts] : facts);

  if (item.subagents) {
    const runs = item.subagents.runs;
    const done = runs.filter((r) => r.status === "done").length;
    return { label: item.name, glue: " ", detail: plural(runs.length, "agent"), facts: outcome(running ? [] : [`${done}/${runs.length} done`]) };
  }

  // A render_html call published an HTML page; a terminal cannot show the page itself, so the row names it.
  if (item.htmlRender) {
    const page = item.htmlRender;
    return { label: "Render", glue: " ", detail: page.title, facts: outcome([`${page.height}px, page in web UI`]) };
  }

  switch (item.category) {
    case "read": {
      let where = path ? shortPath(path, workspace) : item.summary;
      const from = num(a.offset) ?? num(a.start_line) ?? num(a.startLine);
      const limit = num(a.limit);
      const to = num(a.end_line) ?? num(a.endLine) ?? (from !== undefined && limit !== undefined ? from + limit - 1 : undefined);
      if (from !== undefined) where += to !== undefined ? `:${from}-${to}` : `:${from}`;
      return { label: "Read", glue: " ", detail: where, facts: outcome(lines ? [plural(lines, "line")] : []) };
    }
    case "command": {
      const cmd = str(a.command) ?? str(a.cmd) ?? str(a.script) ?? str(a.code) ?? item.summary;
      const lang = str(a.language);
      const { note, command } = splitComments(cmd, lang === "js" ? "//" : "#");
      const label = /bash|shell|terminal|exec/i.test(item.name) ? "Bash" : lang === "js" ? "JavaScript" : lang === "py" ? "Python" : item.name;
      // Success is the expected case and the bullet already says it: only a failure's code is worth a word.
      const exit = failed ? /exit(?:ed)?(?: with)?(?: code|status)?:? (\d+)/i.exec(item.output.slice(-300)) : null;
      const facts = exit && exit[1] !== "0" ? [`exit ${exit[1]}`] : [];
      if (lines) facts.push(plural(lines, "line"));
      return { label, glue: " ", detail: label === "Bash" ? `$ ${command}` : (command.split("\n").find((l) => l.trim()) ?? command), facts: outcome(facts), ...(note ? { note } : {}) };
    }
    case "search": {
      const q = str(a.pattern) ?? str(a.query) ?? str(a.regex) ?? str(a.glob) ?? item.summary;
      const scope = path && path !== "." ? ` in ${shortPath(path, workspace)}` : "";
      return { label: item.name, glue: " ", detail: `${q}${scope}`, facts: outcome(lines ? [plural(lines, "result")] : []) };
    }
    case "web": {
      const url = str(a.url) ?? (Array.isArray(a.urls) ? str(a.urls[0]) : undefined);
      const query = str(a.query) ?? str(a.q) ?? (Array.isArray(a.queries) ? str(a.queries[0]) : undefined);
      const many = Array.isArray(a.urls) ? a.urls.length : Array.isArray(a.queries) ? a.queries.length : 1;
      const subject = url ? shortUrl(url) : (query ?? item.summary);
      return { label: item.name, glue: " ", detail: many > 1 ? `${subject} +${many - 1} more` : subject, facts: outcome(lines ? [plural(lines, "line")] : []) };
    }
    case "edit":
    case "write": {
      const facts: string[] = [];
      let diff: NeatRow["diff"];
      let more = 0;
      if (!failed && !running) {
        const stat = item.diffStat ? diffStat(item.diffStat.added, item.diffStat.removed) : undefined;
        facts.push(stat ?? (item.diff || item.diffStat ? "no change" : "done"));
        // The changed lines and a line of context either side: what the edit is about.
        // A folded gap is a boundary, so a line past it is not "next to" the change.
        const all = item.diff?.lines ?? [];
        const changed = (l: (typeof all)[number] | undefined) => l !== undefined && (l.kind === "add" || l.kind === "del");
        const near = all.filter((l, i) => changed(l) || (l.kind === "ctx" && (changed(all[i - 1]) || changed(all[i + 1]))));
        diff = near.slice(0, DIFF_PREVIEW_LINES).map((l) => ({ marker: l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ", text: l.text }));
        more = Math.max(0, near.length - DIFF_PREVIEW_LINES);
      }
      return {
        label: item.category === "write" && !item.diff?.removed ? "Write" : "Update",
        glue: "",
        ...(path ? { detail: `(${shortPath(path, workspace)})` } : {}),
        facts: outcome(facts),
        ...(diff && diff.length > 0 ? { diff } : {}),
        ...(more > 0 ? { more } : {}),
      };
    }
    default:
      return { label: item.name, glue: " ", detail: item.summary, facts: outcome(lines ? [plural(lines, "line")] : []) };
  }
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** A thought's title: its bold opening line when it has one (OpenAI-style summaries), else its first sentence. */
export function thoughtTitle(text: string): string {
  const bold = /^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/.exec(text.trim());
  if (bold) return (bold[1] as string).trim();
  let inFence = false;
  let line = "";
  for (const l of text.split("\n")) {
    if (FENCE.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && l.trim()) {
      line = l;
      break;
    }
  }
  const plain = line.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  const sentence = /^(.{12,}?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 72 ? `${sentence.slice(0, 71).trimEnd()}…` : sentence;
}

/** "~340", "~1.2k": a thought's size in tokens, roughly. */
export function thoughtTokens(text: string): string {
  const n = Math.max(1, Math.round(text.length / 4));
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A harness's mark on the prompt card: π for Pi, as neat-render draws it. */
export function harnessGlyph(harnessId: string): string {
  return ({ pi: "π", omp: "ω", claude: "✻", hermes: "☤" } as Record<string, string>)[harnessId] ?? (harnessId[0]?.toUpperCase() ?? "›");
}
