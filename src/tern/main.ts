#!/usr/bin/env node
// awui: the Agent Web UI drawn natively by Tern. It is a frontend like the
// browser: the server runs the agents and keeps the chats, so leaving awui
// leaves the chat running, and the web UI shows the same chat live.
import { appendFileSync } from "node:fs";
import process from "node:process";
import { connect, type Key, type Session } from "@stencil-hq/tern";
import { applyEvents, type ChatState } from "../web/chat-state.js";
import type { Bootstrap, ChatSnapshot, InteractionAnswer, InteractionRequest, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";
import { chord, editDraft, insert } from "./draft.js";
import { followChat, Server } from "./server.js";
import { EDITOR_ID, STYLESHEET, pickerModels, render, requestChoices, type Actions, type Ui } from "./view.js";

const USAGE = `usage: awui [--harness ID] [--resume [SESSION]] [--chat ID] [--url URL]

Opens a chat with the Agent Web UI server's agents in the current folder,
drawn natively by Tern. The server keeps the chat: leaving awui leaves it
running, and the web UI shows the same chat.

  --harness ID     start the chat with this harness (pi, omp, claude, hermes, …)
  --resume [ID]    continue this folder's latest session, or session ID
  --chat ID        attach to a chat the server has open
  --url URL        the server (default: $AWUI_URL, else http://127.0.0.1:4783)

Keys: Enter sends (steers while the agent works), Shift+Enter starts a line,
Esc stops the agent, Ctrl+P picks the model, Ctrl+T cycles the thinking
level, 1-9 answer a question, Ctrl+D (on an empty composer) leaves.
`;

interface Options {
  url: string;
  harness?: string;
  resume?: string | true;
  chat?: string;
}

function parseArgs(argv: string[]): Options | { exit: number; text: string } {
  const options: Options = { url: process.env.AWUI_URL || "http://127.0.0.1:4783" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { exit: 0, text: USAGE };
      else if (arg === "--url") options.url = value();
      else if (arg === "--harness") options.harness = value();
      else if (arg === "--chat") options.chat = value();
      else if (arg === "--resume") options.resume = argv[i + 1] && !argv[i + 1]?.startsWith("--") ? value() : true;
      else return { exit: 2, text: `awui: unknown argument ${arg}\n\n${USAGE}` };
    } catch (error) {
      return { exit: 2, text: `awui: ${(error as Error).message}\n` };
    }
  }
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

async function openChat(server: Server, options: Options): Promise<{ boot: Bootstrap; chat: ChatSnapshot }> {
  const boot = await server.call<Bootstrap>("/api/bootstrap");
  if (options.chat) return { boot, chat: await server.call<ChatSnapshot>(`/api/chats/${encodeURIComponent(options.chat)}`) };
  const ws = await server.call<WorkspaceInfo>("/api/workspaces/open", { body: { path: process.cwd() } });
  if (options.resume) {
    const overview = await server.call<SessionsOverview>(`/api/sessions?path=${encodeURIComponent(ws.path)}`);
    const found =
      options.resume === true
        ? overview.sessions.find((s) => s.workspaceId === ws.id && (!options.harness || s.harnessId === options.harness))
        : overview.sessions.find((s) => s.id === options.resume);
    if (!found) throw new Error(options.resume === true ? `No session to resume in ${ws.path}` : `No session ${options.resume}`);
    if (found.liveChatId) return { boot, chat: await server.call<ChatSnapshot>(`/api/chats/${encodeURIComponent(found.liveChatId)}`) };
    const body = { harnessId: found.harnessId, workspaceId: found.workspaceId, sessionId: found.id };
    return { boot, chat: await server.call<ChatSnapshot>("/api/chats/resume", { body }) };
  }
  const harnessId = options.harness ?? (process.env.AWUI_HARNESS || boot.harnesses.find((h) => h.available)?.id);
  if (!harnessId) throw new Error("No harness is available on the server");
  return { boot, chat: await server.call<ChatSnapshot>("/api/chats", { body: { harnessId, workspaceId: ws.id } }) };
}

const BUSY = new Set(["running", "stopping", "compacting"]);

/** Strips what would end or break an OSC string. */
const oscText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

async function run(session: Session, server: Server, boot: Bootstrap, snapshot: ChatSnapshot): Promise<void> {
  const harness = boot.harnesses.find((h) => h.id === snapshot.harnessId);
  const path = `/api/chats/${encodeURIComponent(snapshot.chatId)}`;
  let chat: ChatState = snapshot;
  const view: Ui = {
    draft: { text: "", cursor: 0 },
    connection: "connecting",
    picker: null,
    flash: null,
    webUrl: `${server.base}/#chat=${snapshot.chatId}`,
  };
  const surface = session.open({ mode: "inline", title: "awui", role: "awui.session" });
  surface.stylesheet("awui", STYLESHEET);

  let flashTimer: NodeJS.Timeout | undefined;
  const flash = (text: string, tone: "error" | "warning" | "muted" = "error") => {
    view.flash = { text, tone };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      view.flash = null;
      schedule();
    }, 6000);
    schedule();
  };
  const request = async (route: string, init: { method?: string; body?: unknown } = {}) => {
    try {
      await server.call(path + route, init);
      return true;
    } catch (error) {
      flash((error as Error).message);
      return false;
    }
  };

  // Tern's tab follows the agent: OSC 9;4 progress (3 working, 4 waiting on
  // you, 2 failed, 0 idle) and the chat's title.
  let progress = "";
  let title = "";
  const syncTerminal = () => {
    const next = chat.pending.length > 0 ? "4" : BUSY.has(chat.status) ? "3" : chat.status === "error" ? "2" : "0";
    if (next !== progress) process.stdout.write(`\x1b]9;4;${(progress = next)};0\x1b\\`);
    const name = oscText(chat.title ? `${chat.title} · ${harness?.displayName ?? chat.harnessId}` : (harness?.displayName ?? "awui"));
    if (name !== title) process.stdout.write(`\x1b]2;${(title = name)}\x1b\\`);
  };

  let failure: unknown = null;
  let scheduled = false;
  const paint = () => {
    scheduled = false;
    if (surface.closed) return;
    try {
      surface.render(render(chat, harness, view, actions, Date.now()));
    } catch (error) {
      failure = error;
    }
    syncTerminal();
  };
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(paint, 16);
  }

  const answer = (req: InteractionRequest, value: InteractionAnswer) =>
    void request(`/requests/${encodeURIComponent(req.id)}`, { body: { answer: value } });

  /** Sends the composer's text: an answer when the agent asked for one, a steer while it works. */
  const submit = async (text: string): Promise<boolean> => {
    if (!text.trim()) return false;
    const asking = chat.pending.find((r) => r.kind === "input" || r.kind === "editor");
    if (asking) {
      answer(asking, { kind: asking.kind === "editor" ? "editor" : "input", value: text });
      return true;
    }
    let mode: "normal" | "steer" = "normal";
    if (BUSY.has(chat.status)) {
      if (chat.status !== "running" || !chat.capabilities.supportsSteer) {
        flash(`${harness?.displayName ?? "The agent"} is busy: wait, or Esc to stop it`, "warning");
        return false;
      }
      mode = "steer";
    }
    return request("/messages", { body: { text, mode } });
  };

  const closePicker = () => {
    view.picker = null;
    surface.focus(EDITOR_ID);
  };
  const actions: Actions = {
    answer,
    send: (text) => void submit(text),
    hoverModel: (key) => {
      if (view.picker) view.picker.selected = key;
    },
    pickModel: (key) => {
      closePicker();
      if (key !== chat.config.model) void request("/config", { method: "PATCH", body: { model: key } });
      schedule();
    },
  };

  const cycleThinking = () => {
    const model = chat.config.models.find((m) => m.key === chat.config.model);
    const levels = model?.levels ?? chat.config.thinkingLevels;
    if (!chat.capabilities.supportsThinkingLevel || levels.length === 0) {
      flash("This model has no thinking levels", "muted");
      return;
    }
    const next = levels[(levels.indexOf(chat.config.thinkingLevel ?? "") + 1) % levels.length] as string;
    void request("/config", { method: "PATCH", body: { thinkingLevel: next } });
  };

  const pickerKey = (key: Key) => {
    const picker = view.picker;
    if (!picker) return;
    const models = pickerModels(chat.config, picker.query);
    const at = Math.max(0, models.findIndex((m) => m.key === (picker.selected ?? models[0]?.key)));
    const move = (by: number) => {
      picker.selected = models[Math.min(models.length - 1, Math.max(0, at + by))]?.key ?? null;
    };
    if (key.name === "escape" || chord(key, "c") || chord(key, "p")) closePicker();
    else if (key.name === "up") move(-1);
    else if (key.name === "down") move(1);
    else if (key.name === "page_up") move(-8);
    else if (key.name === "page_down") move(8);
    else if (key.name === "enter") {
      const pick = models[at];
      if (pick) actions.pickModel(pick.key);
    } else if (key.name === "backspace") {
      picker.query = picker.query.slice(0, -1);
      picker.selected = null;
    } else if (key.text !== undefined && !key.ctrl && !key.alt && !key.meta) {
      picker.query += key.text;
      picker.selected = null;
    }
  };

  /** One key; true to leave. */
  const onKey = (key: Key): boolean => {
    if (view.picker) {
      pickerKey(key);
      return false;
    }
    const draft = view.draft;
    const busy = BUSY.has(chat.status);
    if (chord(key, "c")) {
      if (busy) void request("/abort", { body: {} });
      else if (draft.text) Object.assign(draft, { text: "", cursor: 0 });
      else return true;
      return false;
    }
    if (chord(key, "d")) return !draft.text;
    if (key.name === "escape") {
      if (busy) void request("/abort", { body: {} });
      return false;
    }
    if (chord(key, "p")) {
      view.picker = { query: "", selected: chat.config.model };
      surface.focus(null);
      return false;
    }
    if (chord(key, "t")) {
      cycleThinking();
      return false;
    }
    if (key.name === "enter") {
      if (key.shift || key.alt) insert(draft, "\n");
      else {
        const text = draft.text;
        Object.assign(draft, { text: "", cursor: 0 });
        void submit(text).then((sent) => {
          if (!sent && !view.draft.text) Object.assign(view.draft, { text, cursor: text.length });
          schedule();
        });
      }
      return false;
    }
    const choice = !draft.text && !key.ctrl && !key.alt && !key.meta && /^[1-9]$/.test(key.name) ? Number(key.name) - 1 : -1;
    const asked = chat.pending.find((r) => requestChoices(r).length > 0);
    if (choice >= 0 && asked) {
      const picked = requestChoices(asked)[choice];
      if (picked) answer(asked, picked.answer);
      return false;
    }
    editDraft(draft, key);
    return false;
  };

  const stop = followChat(server, snapshot.chatId, snapshot.lastEventId, {
    onEvent: (event) => {
      chat = applyEvents(chat, [event]) ?? chat;
      schedule();
    },
    onState: (state) => {
      view.connection = state;
      schedule();
    },
    onGone: (status) => {
      chat = { ...chat, gone: status === 401 ? "The server wants a sign-in for this device" : "The server closed this chat" };
      schedule();
    },
  });

  paint();
  surface.focus(EDITOR_ID);
  try {
    for await (const input of session) {
      if (process.env.AWUI_DEBUG) appendFileSync(process.env.AWUI_DEBUG, `${JSON.stringify(input)}\n`);
      if (input.type !== "key") continue;
      if (onKey(input.key)) break;
      schedule();
    }
  } finally {
    stop();
    clearTimeout(flashTimer);
    process.stdout.write("\x1b]9;4;0;0\x1b\\");
    await session.close();
  }
  if (failure) process.stderr.write(`awui: drawing failed: ${failure instanceof Error ? failure.message : String(failure)}\n`);
  if (!chat.gone) process.stdout.write(`The chat keeps running on the server.\n  awui --chat ${chat.chatId}\n  ${view.webUrl}\n`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if ("exit" in options) {
    (options.exit === 0 ? process.stdout : process.stderr).write(options.text);
    return options.exit;
  }
  const session = await connect({ app: "awui", features: ["send"] });
  if (!session) {
    process.stderr.write(`awui draws its UI with Tern: run it in a Tern pane. Everywhere else, use the web UI at ${options.url}/\n`);
    return 1;
  }
  const server = new Server(options.url);
  let opened: { boot: Bootstrap; chat: ChatSnapshot };
  try {
    opened = await openChat(server, options);
  } catch (error) {
    await session.close();
    process.stderr.write(`awui: ${(error as Error).message}\n`);
    return 1;
  }
  await run(session, server, opened.boot, opened.chat);
  return 0;
}

process.exitCode = await main();
