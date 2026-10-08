// atui's screen: sessions on the left, the conversation and composer in the
// middle, the info panel on the right, a status line at the bottom; dialogs
// over it all. Global keys: Ctrl+K commands, Ctrl+X then a letter for the
// rest (OpenCode's leader key), PageUp/PageDown scroll, Esc Esc stops the
// agent, Ctrl+C clears, stops, or (twice) quits.
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { PaletteItem } from "../../web/palette.js";
import { isBusy } from "../../web/session-groups.js";
import { STATUS_LABEL } from "../format.js";
import type { Atui } from "../state.js";
import { accentOf } from "../theme.js";
import { Composer } from "./composer.js";
import { AtuiContext } from "./context.js";
import { InfoPanel } from "./panel.js";
import { Picker } from "./picker.js";
import { RequestCard } from "./request.js";
import { Sidebar } from "./sidebar.js";
import { Transcript } from "./transcript.js";

type Dialog = "palette" | "models" | "harness" | null;

const LEADER_MS = 2000;
const TWICE_MS = 1200;

export const LEADER_HELP = "b sessions · s browse · i info · n new · m model · t thinking · h harness · c compact · f full/compact · e work · q quit";

export function App(p: { app: Atui; onExit: () => void }) {
  const app = p.app;
  const t = app.theme;
  const size = useTerminalDimensions();
  const [sidebar, setSidebar] = createSignal(size().width >= 110);
  const [panel, setPanel] = createSignal(size().width >= 150);
  const [focus, setFocus] = createSignal<"composer" | "sidebar">("composer");
  const [dialog, setDialog] = createSignal<Dialog>(null);
  const [showWork, setShowWork] = createSignal(false);
  const [compactChoice, setCompactChoice] = createSignal<boolean | null>(null);
  const [hint, setHint] = createSignal<string | null>(null);
  let leaderUntil = 0;
  let lastCtrlC = 0;
  let lastEsc = 0;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let composer: TextareaRenderable | undefined;
  let scroller: ScrollBoxRenderable | undefined;

  const flash = (text: string, ms = 2500) => {
    clearTimeout(hintTimer);
    setHint(text);
    hintTimer = setTimeout(() => setHint(null), ms);
  };
  onCleanup(() => clearTimeout(hintTimer));

  const pending = createMemo(() => app.chat()?.pending[0] ?? null);
  const hasPrompt = createMemo(() => app.chat()?.items.some((i) => i.kind === "user") ?? false);
  const sideWidth = () => Math.min(36, Math.max(26, Math.floor(size().width * 0.24)));
  const panelWidth = () => Math.min(36, Math.max(26, Math.floor(size().width * 0.22)));

  // A run that ends: git and limits may have moved.
  createEffect(
    on(
      () => app.chat()?.status,
      (status, before) => {
        if (before && isBusy(before) && !isBusy(status)) {
          void app.refreshGit();
          void app.refreshLimits();
        }
      },
    ),
  );

  const leave = () => {
    setFocus("composer");
    composer?.focus();
  };

  const runLeader = (name: string) => {
    switch (name) {
      case "b":
        setSidebar(!sidebar());
        if (!sidebar()) leave();
        return;
      case "s":
        setSidebar(true);
        setFocus("sidebar");
        composer?.blur();
        return;
      case "i":
        return setPanel(!panel());
      case "n":
        app.newChat();
        return leave();
      case "m":
        return setDialog("models");
      case "h":
        return setDialog("harness");
      case "t":
        return app.cycleThinking();
      case "c":
        return void app.compact();
      case "f":
        setCompactChoice((v) => !(v ?? (app.chat()?.context?.percent ?? 0) >= 80));
        return;
      case "e":
        return setShowWork(!showWork());
      case "q":
        return p.onExit();
      default:
        flash(`^X ${name}: not a command (${LEADER_HELP})`);
    }
  };

  useKeyboard((key) => {
    if (dialog()) return;
    if (Date.now() < leaderUntil && !key.ctrl) {
      key.preventDefault();
      leaderUntil = 0;
      setHint(null);
      return runLeader(key.name);
    }
    if (key.ctrl && key.name === "x") {
      key.preventDefault();
      leaderUntil = Date.now() + LEADER_MS;
      return flash(`^X  ${LEADER_HELP}`, LEADER_MS);
    }
    if (key.ctrl && (key.name === "k" || key.name === "p")) {
      key.preventDefault();
      return setDialog("palette");
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      const step = Math.max(3, Math.floor(size().height / 2));
      scroller?.scrollBy(key.name === "pageup" ? -step : step);
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (focus() === "composer" && composer && composer.plainText) return composer.clear();
      if (app.busy()) return app.stop();
      if (Date.now() - lastCtrlC < TWICE_MS) return p.onExit();
      lastCtrlC = Date.now();
      return flash("Ctrl+C again to quit (the chats keep running on the server)");
    }
    if (key.name === "escape" && focus() === "composer" && !pending() && app.busy()) {
      key.preventDefault();
      if (Date.now() - lastEsc < TWICE_MS) {
        lastEsc = 0;
        return app.stop();
      }
      lastEsc = Date.now();
      return flash("Esc again to stop the agent");
    }
  });

  const paletteItems = (): PaletteItem[] => {
    const items: PaletteItem[] = [];
    const c = app.chat();
    const boot = app.boot();
    const name = (id: string) => boot?.harnesses.find((h) => h.id === id)?.displayName ?? id;
    const idle = c ? c.status === "idle" || c.status === "error" : true;
    const add = (item: Omit<PaletteItem, "section"> & { section?: string }) => items.push({ section: "Actions", ...item });
    add({ id: "new", label: "New chat", hint: "^X N", run: () => runLeader("n") });
    if (c && app.busy()) add({ id: "stop", label: "Stop the agent", hint: "Esc Esc", run: app.stop });
    add({ id: "sessions", label: "Browse sessions", hint: "^X S", run: () => runLeader("s") });
    add({ id: "sidebar", label: sidebar() ? "Hide sessions" : "Show sessions", hint: "^X B", run: () => runLeader("b") });
    add({ id: "panel", label: panel() ? "Hide info panel" : "Show info panel", hint: "^X I", run: () => runLeader("i") });
    add({ id: "work", label: showWork() ? "Fold the work" : "Show the work of every turn", hint: "^X E", run: () => runLeader("e") });
    if (c?.capabilities.supportsCompact) add({ id: "compact", label: "Compact context", hint: "^X C", disabled: idle ? undefined : "Wait until the agent is idle", run: () => runLeader("c") });
    add({ id: "model", label: "Choose model…", hint: "^X M", disabled: c?.capabilities.supportsModelSelection ? undefined : "Start a chat first", run: () => setDialog("models") });
    add({ id: "harness", label: "Choose harness…", hint: "^X H", run: () => setDialog("harness") });
    add({ id: "quit", label: "Quit atui", hint: "^X Q", searchOnly: true, run: p.onExit });
    const sessions = app.overview().sessions;
    sessions.forEach((s, i) => {
      items.push({
        id: `s:${s.id}`,
        section: "Sessions",
        label: s.title || "New chat",
        hint: app.overview().workspaces.find((w) => w.id === s.workspaceId)?.name ?? "",
        keywords: name(s.harnessId),
        searchOnly: i >= 8,
        current: c !== null && (c.sessionId === s.id || s.liveChatId === c.chatId),
        run: () => void app.openSession(s),
      });
    });
    if (c?.capabilities.supportsThinkingLevel) {
      for (const level of c.config.thinkingLevels) {
        items.push({ id: `t:${level}`, section: "Thinking", label: `Thinking: ${level}`, searchOnly: true, current: level === c.config.thinkingLevel, disabled: idle ? undefined : "Wait until the agent is idle", run: () => void app.configure({ thinkingLevel: level }) });
      }
    }
    return items;
  };

  const modelItems = (): PaletteItem[] => {
    const c = app.chat();
    if (!c) return [];
    const idle = c.status === "idle" || c.status === "error";
    return c.config.models.map((m) => ({
      id: m.key,
      section: m.provider,
      label: m.name,
      hint: m.provider,
      keywords: m.key,
      current: m.key === c.config.model,
      disabled: idle ? undefined : "Wait until the agent is idle",
      run: () => void app.configure({ model: m.key }),
    }));
  };

  const harnessItems = (): PaletteItem[] =>
    (app.boot()?.harnesses ?? []).map((h) => ({
      id: h.id,
      section: "Harness for new chats",
      label: h.displayName,
      hint: h.version ?? "",
      current: h.id === app.harnessId(),
      disabled: h.available ? undefined : (h.reason ?? "Not available"),
      run: () => app.chooseHarness(h.id),
    }));

  const title = () => {
    const c = app.chat();
    if (!c) return app.workspace()?.name ?? "atui";
    return c.title || "New chat";
  };

  return (
    <AtuiContext.Provider value={app}>
      <box flexDirection="column" width="100%" height="100%">
        <box flexDirection="row" flexGrow={1}>
          <Show when={sidebar()}>
            <Sidebar active={focus() === "sidebar" && !dialog()} width={sideWidth()} onOpened={leave} onLeave={leave} />
          </Show>
          <box flexDirection="column" flexGrow={1}>
            <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2}>
              <text flexGrow={1} fg={t().text} wrapMode="none" truncate>
                <b>{title()}</b>
              </text>
              <Show when={app.chat()}>
                {(c) => (
                  <text flexShrink={0}>
                    <span style={{ fg: accentOf(t(), app.harness()?.accent) }}>{app.harness()?.displayName ?? c().harnessId}</span>
                    <span style={{ fg: isBusy(c().status) ? t().accent : c().status === "error" ? t().danger : t().muted }}>{`  ${STATUS_LABEL[c().status]}`}</span>
                    <span style={{ fg: t().muted }}>{`  ${c().workspace.name}`}</span>
                  </text>
                )}
              </Show>
            </box>
            <Show
              when={hasPrompt()}
              fallback={
                <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
                  <text fg={t().text}>
                    <b>{`What should ${app.harness()?.displayName ?? "the agent"} do in ${app.workspace()?.name ?? "this project"}?`}</b>
                  </text>
                  <text fg={t().muted}>It runs with its normal tools, as you, in this folder.</text>
                </box>
              }
            >
              <Transcript ref={(el) => (scroller = el as ScrollBoxRenderable)} showWork={showWork()} />
            </Show>
            <Show when={app.banner()}>
              {(b) => (
                <box flexShrink={0} paddingLeft={2} paddingRight={2}>
                  <text fg={b().level === "error" ? t().danger : b().level === "warning" ? t().warn : t().info} wrapMode="word">
                    {b().text}
                  </text>
                </box>
              )}
            </Show>
            <Show when={app.chat()?.gone}>
              {(gone) => (
                <box flexShrink={0} paddingLeft={2}>
                  <text fg={t().warn}>{`${gone()} · ^X N for a new chat`}</text>
                </box>
              )}
            </Show>
            <Show
              when={pending()}
              keyed
              fallback={
                <Composer
                  focused={focus() === "composer" && !dialog()}
                  compactChoice={compactChoice()}
                  onCompactChoice={setCompactChoice}
                  ref={(el) => (composer = el)}
                />
              }
            >
              {(request) => <RequestCard request={request} more={(app.chat()?.pending.length ?? 1) - 1} active={focus() === "composer" && !dialog()} />}
            </Show>
          </box>
          <Show when={panel()}>
            <InfoPanel width={panelWidth()} />
          </Show>
        </box>
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={t().surface}>
          <text flexShrink={0} fg={app.conn() === "connected" ? t().ok : app.conn() === "idle" ? t().muted : t().warn}>
            {app.conn() === "connected" ? "● " : app.conn() === "idle" ? "○ " : "◌ "}
          </text>
          <text flexGrow={1} fg={t().muted} wrapMode="none" truncate>
            {hint() ?? "^K commands · ^X B sessions · ^X I info · ^X M model · PgUp/PgDn scroll · Esc Esc stop · ^C ^C quit"}
          </text>
          <text flexShrink={0} fg={t().muted}>{` atui ${app.boot()?.version ?? ""}`}</text>
        </box>
        <Show when={dialog() === "palette"}>
          <Picker title="Commands" placeholder="Search commands, sessions, thinking…" items={paletteItems()} onClose={() => setDialog(null)} />
        </Show>
        <Show when={dialog() === "models"}>
          <Picker title="Model" placeholder="Search models…" items={modelItems()} onClose={() => setDialog(null)} />
        </Show>
        <Show when={dialog() === "harness"}>
          <Picker title="Harness" placeholder="Search harnesses…" items={harnessItems()} onClose={() => setDialog(null)} />
        </Show>
      </box>
    </AtuiContext.Provider>
  );
}
