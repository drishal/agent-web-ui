// Review changes (the web UI's Review, in a terminal): every file this chat
// changed, each edit's lines under it with a line cursor; a comment on a line,
// and all of them sent to the agent as one prompt. ↑/↓ (j/k) a line, ]/[ a
// file, Enter or c comments, x removes one, S sends, Esc closes. Comments
// stay with the chat while atui runs (atui/review.ts lays the rows out).
import { createMemo, createSignal, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { collectChanges, reviewPrompt, type ReviewComment } from "../../web/review.js";
import { clip } from "../format.js";
import { mix } from "../fx.js";
import { firstStop, moveCursor, moveFile, reviewRows, windowStart, type ReviewRow } from "../review.js";
import { useAtui, useTheme } from "./context.js";

const SIGN = { add: "+", del: "-", ctx: " ", hunk: "", gap: "" } as const;

export function ReviewView(p: { onClose: () => void }) {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const chat = () => app.chat();
  const files = createMemo(() => {
    const c = chat();
    return c ? collectChanges(c.items, c.workspace.path) : [];
  });
  const rows = createMemo(() => reviewRows(files()));
  const [at, setAt] = createSignal(firstStop(rows()));
  const [writing, setWriting] = createSignal<{ key: string; draft: string } | null>(null);
  const [sending, setSending] = createSignal(false);
  const comments = () => app.reviewComments(chat()?.chatId ?? "");
  const byKey = createMemo(() => new Map(comments().map((c) => [c.key, c])));
  const height = () => Math.max(6, size().height - 6);
  const start = () => windowStart(rows().length, Math.max(0, at()), height());
  const shown = () => rows().slice(start(), start() + height());
  const current = () => rows()[at()] as Extract<ReviewRow, { kind: "line" }> | undefined;

  const setComments = (list: ReviewComment[]) => {
    const c = chat();
    if (c) app.setReviewComments(c.chatId, list);
  };
  const save = () => {
    const w = writing();
    const row = current();
    setWriting(null);
    if (!w || !row || !w.draft.trim()) return;
    setComments([...comments().filter((c) => c.key !== w.key), { key: w.key, path: row.path, line: row.line, text: w.draft.trim() }]);
  };
  const send = async () => {
    if (comments().length === 0 || sending()) return;
    // File order, then line order: the order the rows are in.
    const order = new Map(rows().map((r, i) => [r.kind === "line" ? r.key : `#${i}`, i]));
    const ordered = [...comments()].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    setSending(true);
    const ok = await app.send(reviewPrompt(ordered));
    setSending(false);
    if (ok) {
      setComments([]);
      p.onClose();
    }
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    const w = writing();
    if (w) {
      // The comment box has the keys but these two.
      if (key.name === "escape") {
        key.preventDefault();
        setWriting(null);
      } else if (key.name === "return") {
        key.preventDefault();
        save();
      }
      return;
    }
    key.preventDefault();
    const list = rows();
    if (key.name === "escape" || key.name === "q") p.onClose();
    else if (key.name === "down" || key.name === "j") setAt((i) => moveCursor(list, i, 1));
    else if (key.name === "up" || key.name === "k") setAt((i) => moveCursor(list, i, -1));
    else if (key.name === "pagedown") setAt((i) => moveCursor(list, i, Math.floor(height() / 2)));
    else if (key.name === "pageup") setAt((i) => moveCursor(list, i, -Math.floor(height() / 2)));
    else if (key.name === "]" || key.name === "n") setAt((i) => moveFile(list, i, 1));
    else if (key.name === "[" || key.name === "p") setAt((i) => moveFile(list, i, -1));
    else if ((key.name === "return" || key.name === "c") && current()) {
      const row = current() as Extract<ReviewRow, { kind: "line" }>;
      setWriting({ key: row.key, draft: byKey().get(row.key)?.text ?? "" });
    } else if (key.name === "x" && current()) setComments(comments().filter((c) => c.key !== current()?.key));
    else if (key.name === "s" && key.shift) void send();
  });

  const lineColor = (kind: string) => (kind === "add" ? t().ok : kind === "del" ? t().danger : t().text2);

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={15} flexDirection="column" backgroundColor={t().bg} paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text flexGrow={1} fg={t().text}>
          <b>Review changes</b>
          <span style={{ fg: t().muted }}>{`  ${files().length} ${files().length === 1 ? "file" : "files"} · ${comments().length} ${comments().length === 1 ? "comment" : "comments"}`}</span>
        </text>
      </box>
      <Show when={files().length > 0} fallback={<text fg={t().muted}>The agent has not edited any files in this chat.</text>}>
        <box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
          <For each={shown()}>
            {(row, i) => {
              const index = () => start() + i();
              const here = () => index() === at();
              if (row.kind === "file") {
                return (
                  <text wrapMode="none" truncate marginTop={index() === 0 ? 0 : 1}>
                    <b style={{ fg: t().text }}>{row.path}</b>
                    <span style={{ fg: t().ok }}>{`  +${row.added}`}</span>
                    <span style={{ fg: t().danger }}>{` −${row.removed}`}</span>
                  </text>
                );
              }
              if (row.kind === "edit") return <text fg={t().muted}>{`  ${row.label}`}</text>;
              const note = () => byKey().get(row.key);
              return (
                <box flexDirection="column">
                  <box flexDirection="row" backgroundColor={here() ? mix(t().bg, t().selection, 0.85) : undefined} onMouseDown={() => setAt(index())}>
                    <text flexShrink={0} fg={here() ? t().accent : t().border}>
                      {here() ? "▌" : " "}
                    </text>
                    <text flexShrink={0} fg={t().muted}>
                      {`${row.line.line !== undefined ? String(row.line.line).padStart(5) : "     "} `}
                    </text>
                    <text flexGrow={1} wrapMode="none" truncate fg={lineColor(row.line.kind)}>
                      {row.line.kind === "hunk" || row.line.kind === "gap" ? clip(row.line.text || "⋯", 120) : `${SIGN[row.line.kind]} ${row.line.text}`}
                    </text>
                  </box>
                  <Show when={note()}>
                    {(n) => (
                      <text fg={t().warn} wrapMode="word">
                        {`        ✎ ${n().text}`}
                      </text>
                    )}
                  </Show>
                  <Show when={writing()?.key === row.key}>
                    <box flexDirection="row" paddingLeft={8} border={["left"]} borderColor={t().accent}>
                      <input
                        focused
                        flexGrow={1}
                        placeholder="What should change here? Enter saves, Esc drops"
                        textColor={t().text}
                        backgroundColor={t().surface}
                        focusedBackgroundColor={t().surface}
                        value={writing()?.draft ?? ""}
                        onInput={(value: string) => setWriting((w) => (w ? { ...w, draft: value } : w))}
                      />
                    </box>
                  </Show>
                </box>
              );
            }}
          </For>
        </box>
      </Show>
      <text flexShrink={0} fg={t().muted} marginBottom={1}>
        {sending() ? "Sending…" : `↑↓ line · ]/[ file · Enter comment · x remove · S send ${comments().length} · Esc close`}
      </text>
    </box>
  );
}
