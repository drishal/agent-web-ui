// The composer (OpenCode's prompt box, with the web UI's chips): Enter sends,
// Shift+Enter or Ctrl+J adds a line; while the agent works Enter steers. The
// line under it names the harness, model and thinking level, the context
// used, and whether the next message compacts first.
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { SlashCommand } from "../../shared/protocol.js";
import { APP_COMMANDS, matchCommands, mergeCommands } from "../../web/commands.js";
import { modelName } from "../../web/turns.js";
import { tokens } from "../format.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";

/** From this share of the context the composer offers to compact first, and from this one it starts on. */
export const COMPACT_OFFER = 50;
export const COMPACT_DEFAULT = 80;

export function Composer(p: {
  focused: boolean;
  compactChoice: boolean | null;
  onCompactChoice: (on: boolean | null) => void;
  /** A click on the footer's harness, model, or thinking level opens its picker. */
  onPick: (picker: "harness" | "models" | "thinking") => void;
  ref: (el: TextareaRenderable) => void;
}) {
  const app = useAtui();
  const t = useTheme();
  let area: TextareaRenderable | undefined;

  // The "/" menu: open while the first word is typed; ↑/↓ move, Tab completes, Esc closes.
  const [text, setText] = createSignal("");
  const [commands, setCommands] = createSignal<SlashCommand[] | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const slash = () => /^\/(\S*)$/.exec(text())?.[1];
  const menuOpen = () => p.focused && slash() !== undefined && !dismissed();
  const menu = createMemo(() => (menuOpen() ? matchCommands(commands() ?? APP_COMMANDS, slash() ?? "").slice(0, 8) : []));
  createEffect(on(() => app.chat()?.chatId, () => setCommands(null)));
  createEffect(
    on(menuOpen, (open) => {
      const c = app.chat();
      if (!open || commands() !== null) return;
      if (!c) return setCommands(mergeCommands([]));
      app.server
        .call<{ commands: SlashCommand[] }>(`/api/chats/${c.chatId}/commands`)
        .then((r) => setCommands(mergeCommands(r.commands)))
        .catch(() => setCommands(mergeCommands([])));
    }),
  );
  createEffect(
    on(slash, (q) => {
      setMenuIndex(0);
      if (q === undefined) setDismissed(false);
    }),
  );
  const complete = (c: SlashCommand) => {
    area?.setText(`/${c.name} `);
    area?.gotoLineTextEnd();
  };
  useKeyboard((key) => {
    if (!menuOpen() || key.defaultPrevented || menu().length === 0) return;
    if (key.name === "escape") {
      key.preventDefault();
      setDismissed(true);
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setMenuIndex((i) => (i + (key.name === "down" ? 1 : -1) + menu().length) % menu().length);
    } else if (key.name === "tab") {
      key.preventDefault();
      const c = menu()[menuIndex()];
      if (c) complete(c);
    } else if (key.name === "return" && !key.shift) {
      const c = menu()[menuIndex()];
      // A command typed in full that takes nothing runs on Enter; otherwise Enter completes it.
      if (c && !(c.name === slash() && !c.hint)) {
        key.preventDefault();
        complete(c);
      }
    }
  });

  const percent = () => app.chat()?.context?.percent ?? null;
  const offer = createMemo(() => {
    const c = app.chat();
    return Boolean(c && c.capabilities.supportsCompact && c.context?.tokens != null && (percent() ?? 0) >= COMPACT_OFFER && !app.busy());
  });
  const compactFirst = () => offer() && (p.compactChoice ?? (percent() ?? 0) >= COMPACT_DEFAULT);

  const submit = async () => {
    const text = area?.plainText ?? "";
    if (!text.trim()) return;
    area?.clear();
    const ok = await app.send(text, compactFirst() ? { compactFirst: true } : {});
    if (ok) p.onCompactChoice(null);
    else if (area && !area.plainText) area.setText(text);
  };

  const placeholder = () => {
    const c = app.chat();
    if (!c) return `Ask ${app.harness()?.displayName ?? "the agent"} to…`;
    if (c.status === "running") return c.capabilities.supportsSteer ? "Steer the agent (Enter) · Esc Esc stops" : "Queue a follow-up (Enter) · Esc Esc stops";
    return "Message the agent…";
  };

  const model = () => {
    const c = app.chat();
    if (!c?.config.model) return null;
    return modelName(c.config.model, c.config.models);
  };

  return (
    <box flexDirection="column" flexShrink={0} marginLeft={2} marginRight={2}>
      <Show when={menu().length > 0}>
        <box flexDirection="column" border borderStyle="rounded" borderColor={t().border} backgroundColor={t().surface} paddingLeft={1} paddingRight={1}>
          <For each={menu()}>
            {(c, i) => (
              <box flexDirection="row" backgroundColor={i() === menuIndex() ? t().selection : undefined} onMouseDown={() => complete(c)}>
                <text flexShrink={0} fg={i() === menuIndex() ? t().text : t().text2}>
                  {`/${c.name}`}
                  <span style={{ fg: t().muted }}>{c.hint ? ` ${c.hint}` : ""}</span>
                </text>
                <text flexGrow={1} fg={t().muted} wrapMode="none" truncate>
                  {c.description ? `  ${c.description}` : ""}
                </text>
                <text flexShrink={0} fg={t().muted}>{` ${c.source}`}</text>
              </box>
            )}
          </For>
          <text fg={t().muted}>↑↓ move · Tab completes · Esc closes</text>
        </box>
      </Show>
      <box
        border
        borderStyle="rounded"
        borderColor={p.focused ? accentOf(t(), app.harness()?.accent) : t().border}
        backgroundColor={t().surface}
        paddingLeft={1}
        paddingRight={1}
      >
        <textarea
          ref={(el: TextareaRenderable) => {
            area = el;
            p.ref(el);
          }}
          focused={p.focused}
          placeholder={placeholder()}
          placeholderColor={t().muted}
          textColor={t().text}
          focusedTextColor={t().text}
          backgroundColor={t().surface}
          focusedBackgroundColor={t().surface}
          cursorColor={t().accent}
          wrapMode="word"
          minHeight={1}
          maxHeight={8}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "return", meta: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onSubmit={() => void submit()}
          onContentChange={() => setText(area?.plainText ?? "")}
        />
      </box>
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" flexGrow={1} overflow="hidden">
          <text flexShrink={0} wrapMode="none" fg={accentOf(t(), app.harness()?.accent)} onMouseDown={() => p.onPick("harness")}>
            {`${app.harness()?.displayName ?? "—"} ▾`}
          </text>
          <Show when={model()}>
            <text flexShrink={1} wrapMode="none" truncate fg={t().text2} onMouseDown={() => p.onPick("models")}>
              {`  ${model()} ▾`}
            </text>
          </Show>
          <Show when={app.chat()?.config.thinkingLevel}>
            <text flexShrink={0} wrapMode="none" fg={t().muted} onMouseDown={() => p.onPick("thinking")}>
              {`  ${app.chat()?.config.thinkingLevel} ▾`}
            </text>
          </Show>
        </box>
        <text flexShrink={0}>
          <Show when={offer()}>
            <span style={{ fg: compactFirst() ? t().warn : t().muted }}>{`${compactFirst() ? "compact first" : "full history"} ${tokens(app.chat()?.context?.tokens ?? 0)} (^X f)  `}</span>
          </Show>
          <Show when={percent() !== null}>
            <span style={{ fg: (percent() ?? 0) >= 80 ? t().warn : t().muted }}>{`ctx ${Math.round(percent() ?? 0)}%`}</span>
          </Show>
        </text>
      </box>
    </box>
  );
}
