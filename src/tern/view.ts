// What awui shows, as TSP nodes: the transcript in `main`, the composer and
// its status line in `dock` (with any question the agent is waiting on), the
// model picker in `layer`. Pure, so it renders the same in tests.
import { html, ui, type Node, type SpanData, type Tone } from "@stencil-hq/tern";
import type { ChatState } from "../web/chat-state.js";
import { relativePath } from "../web/turns.js";
import type {
  AssistantItem,
  ChatConfig,
  ChatItem,
  HarnessStatus,
  InteractionAnswer,
  InteractionRequest,
  ModelInfo,
  NoticeItem,
  SubagentRun,
  ToolCategory,
  ToolDiff,
  ToolItem,
  UserItem,
} from "../shared/protocol.js";
import type { Draft } from "./draft.js";
import type { Connection } from "./server.js";

export interface Ui {
  draft: Draft;
  connection: Connection;
  /** The model picker, while open. */
  picker: { query: string; selected: string | null } | null;
  /** One line under the composer: a refused send, a failed request. */
  flash: { text: string; tone: Tone } | null;
  /** The same chat in the browser. */
  webUrl: string;
}

export interface Actions {
  answer(request: InteractionRequest, answer: InteractionAnswer): void;
  pickModel(key: string): void;
  hoverModel(key: string): void;
  /** Text Tern submits into the composer (the `send` feature). */
  send(text: string): void;
}

export const EDITOR_ID = "dock.ed";

export const STYLESHEET = `
.awui-ask { display: flex; flex-direction: column; gap: 8px }
.awui-ask p { margin: 0 }
.awui-choices { display: flex; flex-wrap: wrap; gap: 8px }
.awui-choices button { padding: 3px 12px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--l2) }
.awui-choices button.primary { background: var(--accent-fill); color: #fff; box-shadow: none }
.awui-choices kbd { margin-right: 6px; opacity: 0.6 }
`;

const TOOL_NAMES: Record<ToolCategory, string | null> = {
  command: "bash",
  read: "read",
  edit: "edit",
  write: "write",
  search: "grep",
  web: "web",
  agent: "task",
  other: null,
};

const TARGET_KINDS: Record<ToolCategory, string> = {
  command: "command",
  read: "path",
  edit: "path",
  write: "path",
  search: "pattern",
  web: "query",
  agent: "text",
  other: "text",
};

const HARNESS_ICONS: Record<string, string> = { pi: "pi-mark", omp: "app-omp", claude: "app-claude", hermes: "app-hermes" };

export function render(chat: ChatState, harness: HarnessStatus | undefined, view: Ui, actions: Actions, now: number) {
  return {
    main: ui.col({ gap: "md" }, ...transcript(chat, now)),
    dock: ui.col({ gap: "sm" }, ...dock(chat, harness, view, actions)),
    layer: view.picker ? modelPicker(chat.config, view.picker, actions) : ui.col(),
  };
}

function transcript(chat: ChatState, now: number): Node[] {
  const head: SpanData[] = [{ t: chat.title || "New chat", s: "strong" }, { t: `  ${chat.workspace.name}`, s: "muted" }];
  const nodes = [ui.text({ key: "head", spans: head })];
  if (chat.gone) nodes.push(ui.text({ key: "gone", tone: "error", text: chat.gone }));
  chat.items.forEach((item, i) => {
    const node = itemNode(item, `i${i}`, chat.workspace.path, now);
    if (node) nodes.push(node);
  });
  return nodes;
}

function itemNode(item: ChatItem, key: string, root: string, now: number): Node | null {
  switch (item.kind) {
    case "user":
      return userNode(item, key);
    case "assistant":
      return assistantNode(item, key);
    case "tool":
      return toolNode(item, key, root, now);
    case "notice":
      return noticeNode(item, key);
    case "request":
      return item.outcome
        ? ui.text({ key, spans: [{ t: item.request.title, s: "muted" }, { t: `  ${item.outcome}`, s: "dim" }] })
        : null;
  }
}

function userNode(item: UserItem, key: string): Node {
  const count = item.imageCount ?? item.images?.length ?? 0;
  return ui.card(
    { key, tone: "user" },
    ui.md({ key: "t" }, item.text),
    count > 0 ? ui.text({ key: "img", spans: [{ t: count === 1 ? "1 image" : `${count} images`, s: "muted" }] }) : null,
  );
}

function assistantNode(item: AssistantItem, key: string): Node {
  const thinkingLive = item.streaming && !item.text;
  return ui.col(
    { key, gap: "sm" },
    item.thinking
      ? ui.section({ key: "th", head: "Thinking", collapsible: true, collapsed: !thinkingLive }, ui.md({ key: "md", stream: thinkingLive }, item.thinking))
      : null,
    item.text ? ui.md({ key: "md", stream: item.streaming }, item.text) : null,
    item.error ? ui.text({ key: "err", tone: "error", text: item.error }) : null,
  );
}

function toolNode(item: ToolItem, key: string, root: string, now: number): Node {
  const running = item.status === "running";
  const body: Node[] = [];
  if (item.subagents && item.subagents.runs.length > 0) body.push(ui.col({ key: "agents", gap: "xs" }, ...item.subagents.runs.map(agentNode)));
  if (item.diff && item.diff.lines.length > 0) body.push(ui.diff({ key: "diff", hunks: hunks(item.diff), path: item.paths[0] && relativePath(item.paths[0], root) }));
  else if (item.output) body.push(ui.ansi({ key: "out", text: item.output }));
  const stat = item.diffStat;
  return ui.tool(
    {
      key,
      name: TOOL_NAMES[item.category] ?? item.name.toLowerCase(),
      title: item.name.charAt(0).toUpperCase() + item.name.slice(1),
      target: item.summary ? relativePath(item.summary, root) : undefined,
      targetKind: TARGET_KINDS[item.category],
      status: item.status === "error" ? "error" : running ? "running" : "done",
      meta: stat ? [`+${stat.added} −${stat.removed}`] : undefined,
      note: item.truncated ? "truncated" : undefined,
      age: running && item.at ? now - item.at : undefined,
      took: !running && item.at && item.endedAt ? item.endedAt - item.at : undefined,
      collapsible: body.length > 0,
      collapsed: body.length > 0 ? !running && !item.subagents : undefined,
      preview: item.diff ? { lines: 12 } : { tail: 4 },
    },
    ...body,
  );
}

/** A tool's diff as Tern's hunks: a new hunk at each header or gap, lines prefixed +, - or space. */
export function hunks(diff: ToolDiff): { oldStart?: number; newStart?: number; lines: string[] }[] {
  const out: { oldStart?: number; newStart?: number; lines: string[] }[] = [];
  let current: (typeof out)[number] | null = null;
  for (const line of diff.lines) {
    if (line.kind === "hunk" || line.kind === "gap") {
      current = null;
      continue;
    }
    if (!current) {
      current = { lines: [] };
      if (line.line !== undefined) {
        if (line.kind === "del") current.oldStart = line.line;
        else current.newStart = line.line;
      }
      out.push(current);
    }
    current.lines.push(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
  }
  return out;
}

const AGENT_STATUS: Record<SubagentRun["status"], string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "aborted",
};

function agentNode(run: SubagentRun, i: number): Node {
  const now = run.activity?.at(-1);
  return ui.agent(
    {
      key: `a${i}`,
      name: run.agent || run.id,
      task: run.task,
      status: AGENT_STATUS[run.status],
      model: run.model,
      stats: { tools: run.toolCount, tokens: run.tokens, cost: run.cost ?? undefined, took: run.durationMs },
      tool: run.status === "running" && now ? { name: now.split(/\s/)[0] ?? now, intent: now } : undefined,
      collapsible: Boolean(run.output || run.error),
      collapsed: true,
    },
    run.error ? ui.text({ key: "err", tone: "error", text: run.error }) : null,
    run.output ? ui.md({ key: "out" }, run.output) : null,
  );
}

function noticeNode(item: NoticeItem, key: string): Node {
  const tone: Tone = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
  const spans: SpanData[] = item.title ? [{ t: `${item.title}: `, s: "strong" }, { t: item.text }] : [{ t: item.text }];
  if (!item.detail) return ui.text({ key, tone, spans });
  return ui.section({ key, head: spans, collapsible: true, collapsed: true }, ui.md({ key: "d" }, item.detail));
}

function dock(chat: ChatState, harness: HarnessStatus | undefined, view: Ui, actions: Actions): Node[] {
  const nodes: Node[] = [];
  chat.pending.forEach((request, i) => nodes.push(requestNode(request, i, actions)));
  const asking = chat.pending.find((r) => r.kind === "input" || r.kind === "editor");
  nodes.push(
    ui.editor({
      key: "ed",
      text: view.draft.text,
      cursor: view.draft.cursor,
      placeholder: asking ? (asking.placeholder ?? "Type the answer, then Enter") : `Ask ${harness?.displayName ?? "the agent"}…`,
      prompt: "› ",
      maxLines: 12,
      sendable: !chat.gone && view.connection === "connected",
      onSend: (event) => actions.send(event.text),
    }),
  );
  if (view.flash) nodes.push(ui.text({ key: "flash", tone: view.flash.tone, text: view.flash.text }));
  nodes.push(statusBar(chat, harness, view));
  return nodes;
}

/** A question the agent is waiting on, with numbered choices (1–9 answer it from the keyboard). */
function requestNode(request: InteractionRequest, i: number, actions: Actions): Node {
  const choices = requestChoices(request);
  return ui.card(
    { key: `rq${i}`, head: request.title, status: "pending", tone: "warning" },
    html.div(
      { key: "body", class: "awui-ask" },
      request.message ? ui.md({ key: "msg" }, request.message) : null,
      choices.length > 0
        ? html.div(
            { key: "choices", class: "awui-choices" },
            ...choices.map((choice, n) =>
              html.button(
                { key: `c${n}`, class: n === 0 ? "primary" : undefined, onClick: () => actions.answer(request, choice.answer) },
                html.kbd({ key: "k", text: String(n + 1) }),
                choice.label,
              ),
            ),
            html.button({ key: "cancel", onClick: () => actions.answer(request, { kind: "cancel" }) }, "Cancel"),
          )
        : ui.text({ key: "how", tone: "muted", text: "Type the answer in the composer and press Enter." }),
    ),
  );
}

export function requestChoices(request: InteractionRequest): { label: string; answer: InteractionAnswer }[] {
  if (request.kind === "confirm")
    return [
      { label: "Yes", answer: { kind: "confirm", confirmed: true } },
      { label: "No", answer: { kind: "confirm", confirmed: false } },
    ];
  if (request.kind === "select") return (request.options ?? []).slice(0, 9).map((value) => ({ label: value, answer: { kind: "select", value } }));
  return [];
}

function statusBar(chat: ChatState, harness: HarnessStatus | undefined, view: Ui): Node {
  const model = chat.config.models.find((m) => m.key === chat.config.model);
  const running = chat.status === "running" || chat.status === "stopping" || chat.status === "compacting";
  const queued = chat.queue.steering.length + chat.queue.followUp.length;
  const percent = chat.context?.percent;
  return ui.status(
    { key: "bar" },
    ui.seg({ key: "h", icon: HARNESS_ICONS[chat.harnessId] ?? "agent", text: harness?.displayName ?? chat.harnessId }),
    ui.seg({
      key: "m",
      icon: "model",
      text: [model?.name ?? chat.config.model ?? "default model", chat.config.thinkingLevel].filter(Boolean).join(" · "),
    }),
    ui.seg({ key: "st", icon: running ? "running" : chat.status === "error" ? "error" : "done", text: STATUS_TEXT[chat.status] }),
    queued > 0 ? ui.seg({ key: "q", icon: "inbox", text: `${queued} queued` }) : null,
    percent !== null && percent !== undefined ? ui.seg({ key: "ctx", icon: "context", text: `${Math.round(percent)}%` }) : null,
    view.connection !== "connected" ? ui.seg({ key: "net", icon: "warn", tone: "warning", text: view.connection === "connecting" ? "Connecting…" : "Reconnecting…" }) : null,
    ui.seg({ key: "web", icon: "globe", text: "Web", href: view.webUrl, title: view.webUrl, priority: 1 }),
    ui.seg({ key: "keys", side: "right", priority: 0, text: running ? "⏎ steer · Esc stop · ^P model" : "⏎ send · ⇧⏎ newline · ^P model · ^D quit" }),
  );
}

const STATUS_TEXT: Record<ChatState["status"], string> = {
  starting: "Starting",
  idle: "Ready",
  running: "Working",
  stopping: "Stopping",
  compacting: "Compacting",
  error: "Error",
  disposed: "Closed",
};

/** The models matching the picker's query, in the server's order. */
export function pickerModels(config: ChatConfig, query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return config.models;
  return config.models.filter((m) => `${m.name} ${m.key}`.toLowerCase().includes(q));
}

function modelPicker(config: ChatConfig, picker: NonNullable<Ui["picker"]>, actions: Actions): Node {
  const models = pickerModels(config, picker.query);
  // The picker is its own modal sheet: it goes straight into the layer region.
  return ui.col(
    ui.picker({
      key: "models",
      size: "md",
      title: "Model",
      icon: "model",
      noun: "models",
      placeholder: "Search models",
      query: picker.query,
      cursor: picker.query.length,
      items: models.map((m) => ({
        id: m.key,
        label: m.name,
        detail: m.provider,
        badges: m.reasoning ? [{ text: "reasoning" }] : undefined,
      })),
      selected: picker.selected ?? models[0]?.key,
      current: config.model ? [config.model] : [],
      empty: "No model matches",
      onSelect: (event) => actions.hoverModel(event.item),
      onActivate: (event) => actions.pickModel(event.item),
    }),
  );
}
