// The conversation, turn by turn as the web UI lays it out: the prompt, one
// "Worked for …" line that opens to the work (thoughts, tool calls, notices),
// the answer as Markdown, and the files it changed. The look is neat-render's
// (the pi extension): the prompt in a rounded card with the harness's mark in
// its top edge, each call a bulleted row with its outcome on a `└` line, an
// edit's first changed lines under it (the changed words brighter), thinking
// as one titled line, and a clicked call framed omp-style (command, Output,
// outcome in the bottom edge). The column is capped at a readable width and
// centred; a gutter on the right maps every turn and scrolls on a click, and
// the prompt of the turn you are reading stays pinned at the top.
import { createEffect, createMemo, createResource, createSignal, For, Index, Match, on, Show, Switch, type Accessor } from "solid-js";
import { BoxRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { AssistantItem, ChatItem, ImageRef, NoticeItem, RequestItem, SubagentRun, ToolItem, UserItem } from "../../shared/protocol.js";
import { buildTurns, formatDuration, latestThought, modelName, modelSwitches, relativePath, saysSomething, type Turn } from "../../web/turns.js";
import { clip, foldLabel, unifiedDiff } from "../format.js";
import { mix } from "../fx.js";
import { filetypeOf, taskBoxes } from "../markdown.js";
import { minimapCells, pinnedTurn, rowToScroll, turnTone, type TurnTone } from "../minimap.js";
import { harnessGlyph, neatRow, thoughtTitle, thoughtTokens } from "../neat.js";
import type { Theme } from "../theme.js";
import { highlightPreview } from "../words.js";
import { useAtui, useTheme } from "./context.js";
import { glideTo, Shimmer, Spinner, usePaced } from "./fx.js";
import { syntaxFor } from "./syntax.js";
import { tick } from "./ticker.js";

const OUTPUT_LINES = 14;
/** The transcript's widest column: past it, lines get too long to read. */
export const MAX_COLUMN = 104;
/** From this terminal width an edit's frame shows its diff side by side. */
const SPLIT_DIFF_WIDTH = 150;
/** Lines of a prompt's image, drawn with the terminal's image protocol or half blocks. */
const IMAGE_ROWS = 8;

/** Half-period of a running row's pulse, in ticks of 100 ms (neat-render's 450 ms). */
const PULSE_TICKS = 4.5;
const pulseOn = () => Math.floor(tick() / PULSE_TICKS) % 2 === 0;

/** The row's bullet: accent when done, red on failure, pulsing while it runs. */
function Bullet(p: { status: "running" | "done" | "error" }) {
  const t = useTheme();
  const color = () => (p.status === "running" ? (pulseOn() ? t().warn : t().muted) : p.status === "error" ? t().danger : t().accent);
  return <span style={{ fg: color() }}>● </span>;
}

/**
 * Markdown blocks atui draws its own way: a top heading over an accent rule,
 * a quote behind a bar, a code block on a tinted panel. Everything else is
 * OpenTUI's default.
 */
function nodeRenderer(theme: Theme) {
  return (token: { type: string; depth?: number }, ctx: { defaultRender: () => Renderable | null }): Renderable | null | undefined => {
    if (token.type !== "heading" && token.type !== "blockquote" && token.type !== "code") return undefined;
    const inner = ctx.defaultRender();
    if (!inner) return inner;
    if (token.type === "heading" && (token.depth ?? 1) > 2) return inner;
    const options =
      token.type === "heading"
        ? { width: "100%" as const, border: ["bottom" as const], borderColor: mix(theme.bg, theme.accent, 0.55) }
        : token.type === "blockquote"
          ? { border: ["left" as const], borderColor: mix(theme.bg, theme.thinking, 0.7), paddingLeft: 1 }
          : { width: "100%" as const, backgroundColor: mix(theme.bg, theme.surface2, 0.6), paddingLeft: 1, paddingRight: 1 };
    // OpenTUI zeroes a custom block's bottom margin, so the gap after it rides as the outer box's padding
    // (a code block's is decided after this runs, so it always keeps one line).
    const gap = Math.max(token.type === "code" ? 1 : 0, typeof inner.marginBottom === "number" ? inner.marginBottom : 0);
    inner.marginBottom = 0;
    const panel = new BoxRenderable(inner.ctx, { flexDirection: "column", ...options });
    panel.add(inner);
    const outer = new BoxRenderable(inner.ctx, { flexDirection: "column", width: "100%", paddingBottom: gap });
    outer.add(panel);
    return outer;
  };
}

const renderers = new Map<string, ReturnType<typeof nodeRenderer>>();
const rendererFor = (theme: Theme) => {
  const key = `${theme.bg}${theme.accent}${theme.thinking}`;
  let hit = renderers.get(key);
  if (!hit) renderers.set(key, (hit = nodeRenderer(theme)));
  return hit;
};

/** Markdown as atui draws it: revealed at a steady pace while it streams, task lists as boxes, tables in rounded borders. */
function Md(p: { text: string; streaming: boolean; fg: string }) {
  const t = useTheme();
  const paced = usePaced(
    () => p.text,
    () => p.streaming,
  );
  return (
    <markdown
      content={taskBoxes(paced())}
      syntaxStyle={syntaxFor(t())}
      fg={p.fg}
      conceal
      streaming={p.streaming || paced().length < p.text.length}
      tableOptions={{ borders: true, borderStyle: "rounded", borderColor: t().border, cellPaddingX: 1 }}
      renderNode={rendererFor(t()) as never}
    />
  );
}

/** One of a prompt's images: drawn in the terminal (kitty's protocol in kitty and Ghostty, sixel, else half blocks), its number on a chip below. */
function PromptImage(p: { image: ImageRef; n: number }) {
  const app = useAtui();
  const t = useTheme();
  const [bytes] = createResource(
    () => p.image.id,
    (id) => app.image(id),
  );
  return (
    <box flexDirection="column" marginRight={2}>
      <Show when={app.imageMode && bytes()}>{(b) => <image source={b()} fit="fit" protocol={app.imageMode ?? "blocks"} width={IMAGE_ROWS * 2 + 4} height={IMAGE_ROWS} />}</Show>
      <text fg={t().muted}>
        <span style={{ fg: t().text2, bg: t().surface2 }}>{` ▣ #${p.n} `}</span>
        <span>{` ${p.image.mimeType.replace("image/", "")}`}</span>
      </text>
    </box>
  );
}

/** The prompt in a rounded card, the harness's mark set into its top edge: ╭─π──╮. */
function UserPrompt(p: { item: UserItem }) {
  const t = useTheme();
  const app = useAtui();
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={t().ok}
      title={harnessGlyph(app.chat()?.harnessId ?? "")}
      titleColor={t().danger}
      backgroundColor={app.glass() ? undefined : t().surface}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
      flexDirection="column"
    >
      <text fg={t().text} wrapMode="word">
        {p.item.text}
        <Show when={p.item.imageCount && !p.item.images?.length}>
          <span style={{ fg: t().muted }}>{`  [${p.item.imageCount} ${p.item.imageCount === 1 ? "image" : "images"}]`}</span>
        </Show>
      </text>
      <Show when={p.item.images?.length}>
        <box flexDirection="row" flexWrap="wrap" marginTop={1}>
          <Index each={p.item.images ?? []}>{(image, i) => <PromptImage image={image()} n={i + 1} />}</Index>
        </box>
      </Show>
    </box>
  );
}

/** One line per thought: "● Thinking: …" while it streams, "▸ Thought: … · ~340 tokens" after; a click opens it. */
function Thought(p: { item: AssistantItem }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  const streaming = () => p.item.streaming && !p.item.text;
  const title = () => thoughtTitle(p.item.thinking);
  const detail = () => (streaming() ? (title() ? `: ${title()}` : "") : `: ${[title(), `~${thoughtTokens(p.item.thinking)} tokens`].filter(Boolean).join(" · ")}`);
  return (
    <box flexDirection="column" onMouseDown={() => setOpen(!open())}>
      <text wrapMode="none" truncate>
        <Show when={streaming()} fallback={<span style={{ fg: t().muted }}>{open() ? "▾ " : "▸ "}</span>}>
          <span style={{ fg: pulseOn() ? t().warn : t().muted }}>● </span>
        </Show>
        <Show when={streaming()} fallback={<span style={{ fg: t().thinking }}>Thought</span>}>
          <Shimmer text="Thinking" base={t().thinking} glow={mix(t().thinking, "#ffffff", 0.6)} />
        </Show>
        <span style={{ fg: t().muted }}>{detail()}</span>
      </text>
      <Show when={open()}>
        <box paddingLeft={2}>
          <text fg={t().muted} wrapMode="word">
            <i>{p.item.thinking.trim()}</i>
          </text>
        </box>
      </Show>
    </box>
  );
}

/**
 * A clicked call, framed the way omp draws it: the call, an Output rule, what
 * it printed (or an edit's diff, highlighted for its language and side by
 * side on a wide terminal), and the outcome set into the bottom edge. The
 * frame is quiet when done, accent while running, red on failure.
 */
function ToolDetails(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const size = useTerminalDimensions();
  const row = createMemo(() => neatRow(p.item, p.workspace));
  const tone = () => (p.item.status === "running" ? t().accent : p.item.status === "error" ? t().danger : t().border);
  const file = () => relativePath(p.item.paths[0] ?? p.item.summary, p.workspace);
  const diff = createMemo(() => (p.item.diff && (p.item.category === "edit" || p.item.category === "write") ? unifiedDiff(file(), p.item.diff) : null));
  const command = () => (p.item.category === "command" && row().detail?.startsWith("$ ") ? (row().detail as string).slice(2) : null);
  const output = createMemo(() => {
    const lines = p.item.output.replace(/\n+$/, "").split("\n");
    const shown = lines.slice(-OUTPUT_LINES).join("\n");
    return lines.length > OUTPUT_LINES ? `… ${lines.length - OUTPUT_LINES} lines above\n${shown}` : shown;
  });
  const status = () => (p.item.status === "running" ? "running…" : row().facts.join(" · "));
  return (
    <box border borderStyle="rounded" borderColor={tone()} bottomTitle={status() ? ` ${status()} ` : undefined} flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
      <Show when={command()}>
        {(c) => (
          <text wrapMode="word">
            <span style={{ fg: t().muted }}>$ </span>
            <span style={{ fg: t().link }}>{c()}</span>
          </text>
        )}
      </Show>
      <Show
        when={diff()}
        fallback={
          <Show when={output()}>
            <Show when={command()}>
              <box border={["top"]} borderColor={tone()} title=" Output " titleColor={t().text2} />
            </Show>
            <text fg={t().text2} wrapMode="char">
              {output()}
            </text>
          </Show>
        }
      >
        {(d) => (
          <diff
            diff={d()}
            view={size().width >= SPLIT_DIFF_WIDTH ? "split" : "unified"}
            filetype={filetypeOf(file())}
            syntaxStyle={syntaxFor(t())}
            showLineNumbers
            wrapMode="word"
            fg={t().text}
            addedBg={mix(t().bg, t().ok, 0.16)}
            removedBg={mix(t().bg, t().danger, 0.16)}
            addedContentBg={mix(t().bg, t().ok, 0.16)}
            removedContentBg={mix(t().bg, t().danger, 0.16)}
            addedSignColor={t().ok}
            removedSignColor={t().danger}
            lineNumberFg={t().muted}
            addedLineNumberBg={mix(t().bg, t().ok, 0.24)}
            removedLineNumberBg={mix(t().bg, t().danger, 0.24)}
          />
        )}
      </Show>
    </box>
  );
}

/** A delegation call's agents as a live tree: what each is doing, how long, and how it ended. */
function AgentTree(p: { runs: SubagentRun[] }) {
  const t = useTheme();
  const mark = (r: SubagentRun) =>
    r.status === "done" ? (
      <span style={{ fg: t().ok }}>✓</span>
    ) : r.status === "failed" ? (
      <span style={{ fg: t().danger }}>✗</span>
    ) : r.status === "stopped" ? (
      <span style={{ fg: t().warn }}>■</span>
    ) : r.status === "running" ? (
      <Spinner />
    ) : (
      <span style={{ fg: t().muted }}>○</span>
    );
  const doing = (r: SubagentRun) => {
    if (r.status === "running") return r.activity?.[r.activity.length - 1] ?? clip(r.task, 60);
    if (r.status === "failed") return r.error ?? "failed";
    return [r.toolCount !== undefined ? `${r.toolCount} ${r.toolCount === 1 ? "call" : "calls"}` : "", r.durationMs !== undefined ? formatDuration(r.durationMs) : ""].filter(Boolean).join(" · ") || clip(r.task, 60);
  };
  return (
    <box flexDirection="column" paddingLeft={2}>
      <Index each={p.runs}>
        {(r, i) => (
          <text wrapMode="none" truncate>
            <span style={{ fg: t().border }}>{i === p.runs.length - 1 ? "└─ " : "├─ "}</span>
            {mark(r())}
            <b style={{ fg: t().text2 }}>{` ${r().agent}`}</b>
            <span style={{ fg: t().muted }}>{`  ${doing(r())}`}</span>
          </text>
        )}
      </Index>
    </box>
  );
}

/**
 * One call as neat-render draws it:
 *
 *   # the model's remark, when the command opened with one
 *   ● Bash $ npm test                ● Bash · running…
 *     └ exit 2 · 14 lines              └ $ npm test -- --run …
 *
 * An edit shows its first changed lines under the outcome, a delegation its
 * agents as a tree, and a path links to its file. A click frames it.
 */
function ToolRow(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  const row = createMemo(() => neatRow(p.item, p.workspace));
  const preview = createMemo(() => (row().diff ? highlightPreview(row().diff ?? []) : null));
  const running = () => p.item.status === "running";
  const failed = () => p.item.status === "error";
  const factColor = (f: string) => (failed() || /^(failed|exit [1-9])/.test(f) ? t().danger : t().ok);
  // A running command moves to its own wrapped `└ $` lines, so you can read what is executing.
  const wraps = () => running() && p.item.category === "command" && Boolean(row().detail);
  // A path in the row is a link to the file (where the terminal supports links).
  const href = () => {
    const file = p.item.paths[0];
    if (!file) return null;
    const abs = file.startsWith("/") ? file : `${p.workspace.replace(/\/+$/, "")}/${file}`;
    return `file://${encodeURI(abs)}`;
  };
  return (
    <box flexDirection="column">
      <Show when={row().note}>
        {(note) => (
          <text fg={t().muted} wrapMode="none" truncate>
            <i>{`# ${note()}`}</i>
          </text>
        )}
      </Show>
      <box flexDirection="column" onMouseDown={() => setOpen(!open())}>
        <text wrapMode="none" truncate>
          <Bullet status={p.item.status} />
          <b style={{ fg: t().text }}>{row().label}</b>
          <Show when={!wraps()}>
            <Show when={row().detail}>
              {(d) => (
                <Show when={href()} fallback={<span style={{ fg: t().link }}>{`${row().glue}${d()}`}</span>}>
                  {(url) => (
                    <a href={url()} style={{ fg: t().link }}>
                      {`${row().glue}${d()}`}
                    </a>
                  )}
                </Show>
              )}
            </Show>
          </Show>
          <Show when={running()}>
            <span style={{ fg: t().muted }}> · running…</span>
          </Show>
        </text>
        <Show when={wraps() && row().detail}>
          {(d) => (
            <box flexDirection="row" paddingLeft={2} maxHeight={3} overflow="hidden">
              <text fg={t().muted} flexShrink={0}>
                {"└ "}
              </text>
              <text fg={t().link} wrapMode="word">
                {d()}
              </text>
            </box>
          )}
        </Show>
        <Show when={!running() && row().facts.length > 0}>
          <box paddingLeft={2}>
            <text wrapMode="none" truncate>
              <span style={{ fg: t().muted }}>└ </span>
              <Index each={row().facts}>
                {(f, i) => (
                  <>
                    <Show when={i > 0}>
                      <span style={{ fg: t().muted }}> · </span>
                    </Show>
                    <span style={{ fg: factColor(f()) }}>{f()}</span>
                  </>
                )}
              </Index>
            </text>
          </box>
        </Show>
        <Show when={p.item.subagents?.runs.length}>
          <AgentTree runs={p.item.subagents?.runs ?? []} />
        </Show>
        <Show when={!open() && preview()}>
          {(lines) => (
            <box flexDirection="column" paddingLeft={4}>
              <Index each={lines()}>
                {(l) => {
                  const color = () => (l().marker === "+" ? t().ok : l().marker === "-" ? t().danger : t().muted);
                  // The words that changed stand out on a tinted ground; the rest of a changed line is a softer tone.
                  return (
                    <text wrapMode="none" truncate>
                      <span style={{ fg: color() }}>{`${l().marker} `}</span>
                      <Index each={l().segments}>
                        {(seg) => (
                          <span
                            style={{
                              fg: l().marker === " " ? t().muted : seg().changed ? color() : mix(color(), t().muted, 0.45),
                              bg: seg().changed && l().segments.length > 1 ? mix(t().bg, color(), 0.28) : undefined,
                            }}
                          >
                            {seg().text}
                          </span>
                        )}
                      </Index>
                    </text>
                  );
                }}
              </Index>
              <Show when={row().more}>{(n) => <text fg={t().muted}>{`… ${n()} more`}</text>}</Show>
            </box>
          )}
        </Show>
      </box>
      <Show when={open()}>
        <ToolDetails item={p.item} workspace={p.workspace} />
      </Show>
    </box>
  );
}

function Notice(p: { item: NoticeItem }) {
  const t = useTheme();
  const color = () => (p.item.level === "error" ? t().danger : p.item.level === "warning" ? t().warn : t().info);
  return (
    <text fg={color()} wrapMode="word">
      {p.item.level === "info" ? "ℹ " : "! "}
      <span style={{ fg: p.item.level === "info" ? t().muted : color() }}>{p.item.detail ? (p.item.title ?? p.item.text) : p.item.text}</span>
    </text>
  );
}

function Request(p: { item: RequestItem }) {
  const t = useTheme();
  const denied = () => /Denied|Cancelled|Dismissed/.test(p.item.outcome ?? "");
  return (
    <text fg={p.item.outcome ? (denied() ? t().warn : t().muted) : t().warn} wrapMode="word">
      {p.item.outcome ? (denied() ? "✗ " : "✓ ") : "? "}
      <span style={{ fg: t().text2 }}>{clip(p.item.request.title, 80)}</span>
      <span style={{ fg: t().muted }}>{` → ${p.item.outcome ?? "waiting for you"}`}</span>
    </text>
  );
}

function ProcessItem(p: { item: ChatItem; workspace: string }) {
  const t = useTheme();
  return (
    <Switch>
      <Match when={p.item.kind === "tool" && (p.item as ToolItem)}>{(item) => <ToolRow item={item()} workspace={p.workspace} />}</Match>
      <Match when={p.item.kind === "assistant" && (p.item as AssistantItem)}>
        {(item) => (
          <box flexDirection="column">
            <Show when={item().thinking.trim()}>
              <Thought item={item()} />
            </Show>
            <Show when={saysSomething(item().text)}>
              <box paddingLeft={2}>
                <Md text={item().text} streaming={item().streaming} fg={t().text2} />
              </box>
            </Show>
          </box>
        )}
      </Match>
      <Match when={p.item.kind === "notice" && (p.item as NoticeItem)}>{(item) => <Notice item={item()} />}</Match>
      <Match when={p.item.kind === "request" && (p.item as RequestItem)}>{(item) => <Request item={item()} />}</Match>
    </Switch>
  );
}

function Fold(p: { turn: Turn; open: boolean; onToggle: () => void }) {
  const t = useTheme();
  const label = () => {
    void tick();
    return foldLabel(p.turn);
  };
  const thought = () => (p.turn.live && !p.open ? latestThought(p.turn) : null);
  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row" onMouseDown={p.onToggle}>
        <text fg={t().muted}>
          <Show when={p.turn.live} fallback={`${p.open ? "▾ " : "▸ "}${label()}`}>
            <Spinner />
            {" "}
            <Shimmer text={label()} />
          </Show>
        </text>
      </box>
      <Show when={thought()}>
        {(line) => (
          <box paddingLeft={2}>
            <text fg={t().muted} wrapMode="word">
              {`✻ ${line()}`}
            </text>
          </box>
        )}
      </Show>
    </box>
  );
}

function Answer(p: { item: AssistantItem }) {
  const t = useTheme();
  return (
    <box flexDirection="column" marginTop={1}>
      <Show when={p.item.text.trim()}>
        <Md text={p.item.text} streaming={p.item.streaming} fg={t().text} />
      </Show>
      <Show when={p.item.error && p.item.error !== "Stopped"}>
        <text fg={t().danger} wrapMode="word">
          {`✗ ${p.item.error}`}
        </text>
      </Show>
      <Show when={p.item.error === "Stopped"}>
        <text fg={t().warn}>■ Stopped</text>
      </Show>
    </box>
  );
}

function TurnView(p: { turn: Accessor<Turn>; workspace: string; open: boolean; onToggle: () => void; switchedTo: string | null }) {
  const t = useTheme();
  const hasProcess = () => p.turn().process.length > 0 || Boolean(p.turn().answer?.thinking.trim());
  const files = () => p.turn().changedFiles.map((f) => relativePath(f, p.workspace));
  return (
    <box flexDirection="column" width="100%" maxWidth={MAX_COLUMN}>
      <Show when={p.switchedTo}>
        {(name) => (
          <box flexDirection="row" marginTop={1}>
            <text fg={t().muted}>{`──── Switched to ${name()} ────`}</text>
          </box>
        )}
      </Show>
      <Show when={p.turn().prompt}>{(prompt) => <UserPrompt item={prompt()} />}</Show>
      <Show when={hasProcess() || p.turn().live}>
        <Fold turn={p.turn()} open={p.open} onToggle={p.onToggle} />
        <Show when={p.open}>
          <box flexDirection="column" paddingLeft={2} marginTop={1}>
            {/* The answer's own thought sits where the answer came, before any work that followed it. */}
            <Index each={p.turn().process.slice(0, p.turn().answerAt)}>{(item) => <ProcessItem item={item()} workspace={p.workspace} />}</Index>
            <Show when={p.turn().answer?.thinking.trim()}>
              <Thought item={p.turn().answer as AssistantItem} />
            </Show>
            <Index each={p.turn().process.slice(p.turn().answerAt)}>{(item) => <ProcessItem item={item()} workspace={p.workspace} />}</Index>
          </box>
        </Show>
      </Show>
      <Show when={p.turn().answer}>{(a) => <Answer item={a()} />}</Show>
      <For each={p.turn().errors}>{(item) => <Notice item={item} />}</For>
      <Show when={files().length > 0 && !p.turn().live}>
        <box marginTop={1}>
          <text fg={t().muted} wrapMode="word">
            {`✎ Changed ${files().length} ${files().length === 1 ? "file" : "files"} · `}
            <span style={{ fg: t().text2 }}>{files().slice(0, 4).join(", ") + (files().length > 4 ? ` +${files().length - 4}` : "")}</span>
          </text>
        </box>
      </Show>
      <For each={p.turn().after}>{(item) => <Notice item={item} />}</For>
    </box>
  );
}

interface Geometry {
  /** Where each turn starts, in lines from the top of the transcript. */
  tops: number[];
  content: number;
  top: number;
  height: number;
}

const sameGeometry = (a: Geometry, b: Geometry) => a.content === b.content && a.top === b.top && a.height === b.height && a.tops.length === b.tops.length && a.tops.every((v, i) => v === b.tops[i]);

/** The gutter: a tick per turn in its tone, the visible stretch as a brighter track; a click jumps there. */
function Minimap(p: { geometry: Geometry; tones: TurnTone[]; onJump: (to: number) => void }) {
  const t = useTheme();
  const cells = createMemo(() =>
    minimapCells(
      p.geometry.tops.map((top, i) => ({ top, tone: p.tones[i] ?? "plain" })),
      p.geometry.content,
      p.geometry.top,
      p.geometry.height,
      p.geometry.height,
    ),
  );
  const toneColor = (tone: TurnTone) => ({ live: t().accent, failed: t().danger, edited: t().ok, rendered: t().thinking, plain: t().text2 })[tone];
  return (
    <box flexDirection="column" width={1} flexShrink={0}>
      <Index each={cells()}>
        {(cell, row) => (
          <text
            fg={cell().tone ? toneColor(cell().tone as TurnTone) : cell().inView ? mix(t().muted, t().text, 0.35) : t().border}
            onMouseDown={() => p.onJump(rowToScroll(row, cells().length, p.geometry.content, p.geometry.height))}
          >
            {cell().tone ? (cell().tone === "live" ? "◆" : "●") : cell().inView ? "┃" : "│"}
          </text>
        )}
      </Index>
    </box>
  );
}

export function Transcript(p: { ref?: (el: unknown) => void; showWork: boolean }) {
  const app = useAtui();
  const t = useTheme();
  const turns = createMemo(() => {
    const c = app.chat();
    return c ? buildTurns(c.items, c.status) : [];
  });
  const switches = createMemo(() => modelSwitches(turns()));
  const [overrides, setOverrides] = createSignal<Record<string, boolean>>({});
  // Opening or folding every turn (C-x e, vim's zR/zM) wins over turns opened or folded one by one.
  createEffect(on(() => p.showWork, () => setOverrides({}), { defer: true }));
  const isOpen = (turn: Turn) => overrides()[turn.id] ?? (p.showWork || turn.live);
  const workspace = () => app.chat()?.workspace.path ?? "";
  const models = () => app.chat()?.config.models ?? [];

  // Where the turns are and what is on screen, read on the clock: the gutter and the pinned prompt follow it.
  let scroller: ScrollBoxRenderable | undefined;
  const [geometry, setGeometry] = createSignal<Geometry>({ tops: [], content: 0, top: 0, height: 0 }, { equals: sameGeometry });
  createEffect(
    on(tick, () => {
      if (!scroller) return;
      const base = scroller.content.y;
      setGeometry({
        tops: scroller.content.getChildren().map((c) => (c as { y: number }).y - base),
        content: scroller.scrollHeight,
        top: scroller.scrollTop,
        height: scroller.viewport.height,
      });
    }),
  );
  const tones = createMemo(() => turns().map(turnTone));
  const scrollable = () => geometry().content > geometry().height + 1;
  const pinned = createMemo(() => {
    const at = pinnedTurn(geometry().tops, geometry().top);
    return at === null ? null : (turns()[at]?.prompt ?? null);
  });

  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" flexGrow={1}>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => {
            scroller = el;
            p.ref?.(el);
          }}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={1}
          contentOptions={{ alignItems: "center" }}
          verticalScrollbarOptions={{ visible: false }}
        >
          <Index each={turns()}>
            {(turn) => (
              <TurnView
                turn={turn}
                workspace={workspace()}
                open={isOpen(turn())}
                onToggle={() => setOverrides((o) => ({ ...o, [turn().id]: !isOpen(turn()) }))}
                switchedTo={switches().has(turn().id) ? modelName(switches().get(turn().id) as string, models()) : null}
              />
            )}
          </Index>
        </scrollbox>
        <Show when={pinned()}>
          {(prompt) => (
            <box position="absolute" top={0} left={0} width="100%" flexDirection="row" justifyContent="center" backgroundColor={app.glass() ? undefined : t().bg} zIndex={5}>
              <box width="100%" maxWidth={MAX_COLUMN} paddingLeft={2} paddingRight={2} flexDirection="row">
                <text fg={t().muted} wrapMode="none" truncate>
                  <span style={{ fg: t().ok }}>{"↑ "}</span>
                  {clip(prompt().text, MAX_COLUMN)}
                </text>
              </box>
            </box>
          )}
        </Show>
      </box>
      <Show when={scrollable()}>
        <Minimap geometry={geometry()} tones={tones()} onJump={(to) => glideTo(scroller, to)} />
      </Show>
    </box>
  );
}
