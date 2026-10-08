// The info panel on the right (OpenCode's session sidebar, with the web UI's
// pieces): context and what fills it, the session's tokens and cost, the
// harness's todos, git, the files this chat changed, and subscription limits.
// Ctrl+X I shows or hides it.
import { createMemo, For, Show } from "solid-js";
import { collectChanges } from "../../web/review.js";
import { clip, limitLine, tokens } from "../format.js";
import { useAtui, useTheme } from "./context.js";

function Heading(p: { label: string }) {
  const t = useTheme();
  return (
    <text fg={t().muted} marginTop={1}>
      <b>{p.label}</b>
    </text>
  );
}

export function InfoPanel(p: { width: number }) {
  const app = useAtui();
  const t = useTheme();
  const c = () => app.chat();
  const files = createMemo(() => {
    const chat = c();
    return chat ? collectChanges(chat.items, chat.workspace.path) : [];
  });
  const w = () => p.width - 4;
  const todoMark = (status: string) => (/done|complete/.test(status) ? "✓" : /progress|active|doing/.test(status) ? "◐" : "○");

  return (
    <box flexDirection="column" width={p.width} flexShrink={0} border={["left"]} borderColor={t().border} paddingLeft={1} paddingRight={1}>
      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: false }}>
        <text fg={t().text}>
          <b>{clip(c()?.title || "New chat", w())}</b>
        </text>
        <Show when={c()?.context}>
          {(ctx) => (
            <box flexDirection="column">
              <Heading label="Context" />
              <text fg={(ctx().percent ?? 0) >= 80 ? t().warn : t().text2}>
                {`${ctx().percent === null ? "—" : `${Math.round(ctx().percent ?? 0)}%`}  ${tokens(ctx().tokens ?? 0)} / ${tokens(ctx().window)}`}
              </text>
              <For each={(ctx().categories ?? []).slice(0, 6)}>
                {(cat) => (
                  <text fg={t().muted} wrapMode="none" truncate>
                    {`${clip(cat.label, w() - 7).padEnd(Math.max(0, w() - 6))}${tokens(cat.tokens).padStart(5)}`}
                  </text>
                )}
              </For>
            </box>
          )}
        </Show>
        <Show when={c()?.usage}>
          {(u) => (
            <box flexDirection="column">
              <Heading label="Session" />
              <text fg={t().text2}>{`${u().turns} turns · ${u().steps} calls`}</text>
              <text fg={t().muted}>{`in ${tokens(u().input + u().cachedInput)} · out ${tokens(u().output)}`}</text>
              <Show when={u().cost !== null}>
                <text fg={t().muted}>{`$${(u().cost ?? 0).toFixed(2)}`}</text>
              </Show>
            </box>
          )}
        </Show>
        <Show when={(c()?.todos.length ?? 0) > 0}>
          <Heading label="Todos" />
          <For each={c()?.todos ?? []}>
            {(todo) => (
              <text fg={/done|complete/.test(todo.status) ? t().muted : /progress|active/.test(todo.status) ? t().text : t().text2} wrapMode="word">
                {`${todoMark(todo.status)} ${todo.text}`}
              </text>
            )}
          </For>
        </Show>
        <Show when={app.git()}>
          {(g) => (
            <box flexDirection="column">
              <Heading label="Git" />
              <text fg={t().text2} wrapMode="none" truncate>
                <span style={{ fg: t().accent }}>{g().branch ?? `detached ${g().head ?? ""}`}</span>
                <span style={{ fg: t().muted }}>{g().upstream ? (g().ahead || g().behind ? `  ↑${g().ahead} ↓${g().behind}` : "  ✓") : "  not pushed"}</span>
              </text>
              <text fg={t().muted}>
                {g().files.length === 0
                  ? "clean"
                  : [
                      g().counts.conflicts ? `${g().counts.conflicts} conflicted` : "",
                      g().counts.staged ? `${g().counts.staged} staged` : "",
                      g().counts.changed ? `${g().counts.changed} changed` : "",
                      g().counts.untracked ? `${g().counts.untracked} new` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </text>
              <Show when={g().added + g().removed > 0}>
                <text>
                  <span style={{ fg: t().ok }}>{`+${g().added}`}</span>
                  <span style={{ fg: t().danger }}>{` −${g().removed}`}</span>
                </text>
              </Show>
            </box>
          )}
        </Show>
        <Show when={files().length > 0}>
          <Heading label="Changed in this chat" />
          <For each={files()}>
            {(f) => (
              <box flexDirection="row">
                <text flexGrow={1} fg={t().text2} wrapMode="none" truncate>
                  {f.path}
                </text>
                <text flexShrink={0}>
                  <span style={{ fg: t().ok }}>{` +${f.added}`}</span>
                  <span style={{ fg: t().danger }}>{` −${f.removed}`}</span>
                </text>
              </box>
            )}
          </For>
        </Show>
        <Show when={(app.limits()?.accounts.length ?? 0) > 0}>
          <Heading label="Limits" />
          <For each={app.limits()?.accounts ?? []}>
            {(a) => (
              <text fg={a.limited ? t().danger : a.windows.some((x) => (x.used ?? 0) >= 0.8) ? t().warn : t().muted} wrapMode="word">
                {limitLine(a)}
              </text>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}
