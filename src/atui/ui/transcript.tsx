// The conversation, turn by turn as the web UI lays it out: the prompt, one
// "Worked for …" line that opens to the work (thoughts, tool calls, notices),
// the answer as Markdown, and the files it changed. Tool rows are OpenCode's
// quiet one-liners; clicking one opens its diff or output.
import { createMemo, createSignal, For, Index, Match, Show, Switch, type Accessor } from "solid-js";
import type { AssistantItem, ChatItem, NoticeItem, RequestItem, ToolItem, UserItem } from "../../shared/protocol.js";
import { buildTurns, latestThought, modelName, modelSwitches, relativePath, saysSomething, type Turn } from "../../web/turns.js";
import { clip, foldLabel, toolTarget, unifiedDiff } from "../format.js";
import { SPINNER, TOOL_MARK, useAtui, useTheme } from "./context.js";
import { syntaxFor } from "./syntax.js";
import { tick } from "./ticker.js";

const OUTPUT_LINES = 14;

function Spinner() {
  const t = useTheme();
  return <span style={{ fg: t().accent }}>{SPINNER[tick() % SPINNER.length]}</span>;
}

function UserPrompt(p: { item: UserItem }) {
  const t = useTheme();
  return (
    <box border={["left"]} borderColor={t().accent} backgroundColor={t().surface} paddingLeft={1} paddingRight={1} marginTop={1}>
      <text fg={t().text} wrapMode="word">
        {p.item.text}
        <Show when={p.item.imageCount}>
          <span style={{ fg: t().muted }}>{`  [${p.item.imageCount} ${p.item.imageCount === 1 ? "image" : "images"}]`}</span>
        </Show>
      </text>
    </box>
  );
}

function Thought(p: { item: AssistantItem }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  return (
    <box flexDirection="column" onMouseDown={() => setOpen(!open())}>
      <text fg={t().thinking} wrapMode="word">
        {"✻ "}
        <span style={{ fg: t().muted }}>{open() ? "Thought" : `Thought · ${clip(p.item.thinking.split("\n").find((l) => l.trim()) ?? "", 96)}`}</span>
      </text>
      <Show when={open()}>
        <box paddingLeft={2}>
          <text fg={t().muted} wrapMode="word">
            {p.item.thinking.trim()}
          </text>
        </box>
      </Show>
    </box>
  );
}

function ToolDetails(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const diff = createMemo(() => (p.item.diff && (p.item.category === "edit" || p.item.category === "write") ? unifiedDiff(relativePath(p.item.paths[0] ?? p.item.summary, p.workspace), p.item.diff) : null));
  const output = createMemo(() => {
    const lines = p.item.output.replace(/\n+$/, "").split("\n");
    const shown = lines.slice(-OUTPUT_LINES).join("\n");
    return lines.length > OUTPUT_LINES ? `… ${lines.length - OUTPUT_LINES} lines above\n${shown}` : shown;
  });
  return (
    <box paddingLeft={2} marginBottom={1}>
      <Show
        when={diff()}
        fallback={
          <box border={["left"]} borderColor={t().border} paddingLeft={1}>
            <text fg={t().text2} wrapMode="char">
              {output() || "(no output)"}
            </text>
          </box>
        }
      >
        {(d) => <diff diff={d()} view="unified" showLineNumbers wrapMode="word" addedBg="#1f3a2a" removedBg="#3a1f22" fg={t().text} />}
      </Show>
    </box>
  );
}

function ToolRow(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  const failed = () => p.item.status === "error";
  return (
    <box flexDirection="column">
      <box flexDirection="row" onMouseDown={() => setOpen(!open())}>
        <text fg={failed() ? t().danger : t().muted} flexShrink={0}>
          <Show when={p.item.status === "running"} fallback={failed() ? "✗ " : `${TOOL_MARK[p.item.category] ?? "•"} `}>
            <Spinner />
            {" "}
          </Show>
          <span style={{ fg: failed() ? t().danger : t().text2 }}>{p.item.name}</span>
        </text>
        <text fg={t().muted} flexGrow={1} wrapMode="none" truncate>
          {`  ${toolTarget(p.item, p.workspace)}${failed() ? " · failed" : ""}`}
        </text>
        <Show when={p.item.diffStat}>
          {(s) => (
            <text flexShrink={0}>
              <span style={{ fg: t().ok }}>{s().added > 0 ? ` +${s().added}` : ""}</span>
              <span style={{ fg: t().danger }}>{s().removed > 0 ? ` −${s().removed}` : ""}</span>
            </text>
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
