// The conversation, turn by turn as the web UI lays it out: the prompt, one
// "Worked for …" line that opens to the work (thoughts, tool calls, notices),
// the answer as Markdown, and the files it changed. The look is neat-render's
// (the pi extension): the prompt in a rounded card with the harness's mark in
// its top edge, each call a bulleted row with its outcome on a `└` line, an
// edit's first changed lines under it, thinking as one titled line, and a
// clicked call framed omp-style (command, Output, outcome in the bottom edge).
import { createMemo, createSignal, For, Index, Match, Show, Switch, type Accessor } from "solid-js";
import type { AssistantItem, ChatItem, NoticeItem, RequestItem, ToolItem, UserItem } from "../../shared/protocol.js";
import { buildTurns, latestThought, modelName, modelSwitches, relativePath, saysSomething, type Turn } from "../../web/turns.js";
import { clip, foldLabel, unifiedDiff } from "../format.js";
import { harnessGlyph, neatRow, thoughtTitle, thoughtTokens } from "../neat.js";
import { SPINNER, useAtui, useTheme } from "./context.js";
import { syntaxFor } from "./syntax.js";
import { tick } from "./ticker.js";

const OUTPUT_LINES = 14;

function Spinner() {
  const t = useTheme();
  return <span style={{ fg: t().accent }}>{SPINNER[tick() % SPINNER.length]}</span>;
}

/** Half-period of a running row's pulse, in ticks of 100 ms (neat-render's 450 ms). */
const PULSE_TICKS = 4.5;
const pulseOn = () => Math.floor(tick() / PULSE_TICKS) % 2 === 0;

/** The row's bullet: accent when done, red on failure, pulsing while it runs. */
function Bullet(p: { status: "running" | "done" | "error" }) {
  const t = useTheme();
  const color = () => (p.status === "running" ? (pulseOn() ? t().warn : t().muted) : p.status === "error" ? t().danger : t().accent);
  return <span style={{ fg: color() }}>● </span>;
}

/** The prompt in a rounded card, the harness's mark set into its top edge: ╭─π──╮. */
function UserPrompt(p: { item: UserItem }) {
  const t = useTheme();
  const app = useAtui();
  return (
    <box border borderStyle="rounded" borderColor={t().ok} title={harnessGlyph(app.chat()?.harnessId ?? "")} titleColor={t().danger} backgroundColor={t().surface} paddingLeft={1} paddingRight={1} marginTop={1}>
      <text fg={t().text} wrapMode="word">
        {p.item.text}
        <Show when={p.item.imageCount}>
          <span style={{ fg: t().muted }}>{`  [${p.item.imageCount} ${p.item.imageCount === 1 ? "image" : "images"}]`}</span>
        </Show>
      </text>
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
        <span style={{ fg: t().thinking }}>{streaming() ? "Thinking" : "Thought"}</span>
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
 * it printed (or an edit's diff), and the outcome set into the bottom edge.
 * The frame is quiet when done, accent while running, red on failure.
 */
function ToolDetails(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const row = createMemo(() => neatRow(p.item, p.workspace));
  const tone = () => (p.item.status === "running" ? t().accent : p.item.status === "error" ? t().danger : t().border);
  const diff = createMemo(() => (p.item.diff && (p.item.category === "edit" || p.item.category === "write") ? unifiedDiff(relativePath(p.item.paths[0] ?? p.item.summary, p.workspace), p.item.diff) : null));
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
        {(d) => <diff diff={d()} view="unified" showLineNumbers wrapMode="word" addedBg="#1f3a2a" removedBg="#3a1f22" fg={t().text} />}
      </Show>
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
 * An edit shows its first changed lines under the outcome. A click frames it.
 */
function ToolRow(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  const row = createMemo(() => neatRow(p.item, p.workspace));
  const running = () => p.item.status === "running";
  const failed = () => p.item.status === "error";
  const factColor = (f: string) => (failed() || /^(failed|exit [1-9])/.test(f) ? t().danger : t().ok);
  // A running command moves to its own wrapped `└ $` lines, so you can read what is executing.
  const wraps = () => running() && p.item.category === "command" && Boolean(row().detail);
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
            <Show when={row().detail}>{(d) => <span style={{ fg: t().link }}>{`${row().glue}${d()}`}</span>}</Show>
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
        <Show when={!open() && row().diff}>
          {(lines) => (
            <box flexDirection="column" paddingLeft={4}>
              <Index each={lines()}>
                {(l) => (
                  <text wrapMode="none" truncate fg={l().marker === "+" ? t().ok : l().marker === "-" ? t().danger : t().muted}>
                    {`${l().marker} ${l().text}`}
                  </text>
                )}
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
                <markdown content={item().text} syntaxStyle={syntaxFor(t())} fg={t().text2} conceal streaming={item().streaming} />
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
          <Show when={p.turn.live} fallback={p.open ? "▾ " : "▸ "}>
            <Spinner />
            {" "}
          </Show>
          {label()}
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
        <markdown content={p.item.text} syntaxStyle={syntaxFor(t())} fg={t().text} conceal streaming={p.item.streaming} />
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
    <box flexDirection="column">
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
            <Index each={p.turn().process}>{(item) => <ProcessItem item={item()} workspace={p.workspace} />}</Index>
            <Show when={p.turn().answer?.thinking.trim()}>
              <Thought item={p.turn().answer as AssistantItem} />
            </Show>
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

export function Transcript(p: { ref?: (el: unknown) => void; showWork: boolean }) {
  const app = useAtui();
  const turns = createMemo(() => {
    const c = app.chat();
    return c ? buildTurns(c.items, c.status) : [];
  });
  const switches = createMemo(() => modelSwitches(turns()));
  const [overrides, setOverrides] = createSignal<Record<string, boolean>>({});
  const isOpen = (turn: Turn) => overrides()[turn.id] ?? (p.showWork || turn.live);
  const workspace = () => app.chat()?.workspace.path ?? "";
  const models = () => app.chat()?.config.models ?? [];
  return (
    <scrollbox ref={p.ref} flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={2} paddingRight={2} paddingBottom={1}>
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
  );
}
