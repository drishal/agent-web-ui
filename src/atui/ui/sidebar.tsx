// Sessions, grouped as the web sidebar does (Needs you, Working, Pinned, then
// projects, this one first). Ctrl+X S moves here; ↑/↓ and Enter open one,
// Esc goes back to the composer.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { ProjectSession } from "../../shared/protocol.js";
import { groupByProject, isBusy, sidebarSections } from "../../web/session-groups.js";
import { clip } from "../format.js";
import { accentOf } from "../theme.js";
import { SPINNER, useAtui, useTheme } from "./context.js";
import { tick } from "./ticker.js";

const PER_PROJECT = 6;
const PER_OTHER = 3;

type Row = { kind: "head"; label: string; color?: string; count: number } | { kind: "session"; s: ProjectSession; project?: string };

function age(iso: string | null): string {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function Sidebar(p: { active: boolean; width: number; onOpened: () => void; onLeave: () => void }) {
  const app = useAtui();
  const t = useTheme();
  const isActive = (s: ProjectSession) => {
    const c = app.chat();
    return Boolean(c && ((c.sessionId !== null && s.id === c.sessionId) || s.liveChatId === c.chatId));
  };
  const rows = createMemo<Row[]>(() => {
    const opts = { currentId: app.workspace()?.id ?? null, query: "", harnessId: app.harnessId(), isActive, now: Date.now() };
    const overview = app.overview();
    const sections = sidebarSections(overview, opts);
    const name = (s: ProjectSession) => overview.workspaces.find((w) => w.id === s.workspaceId)?.name ?? "";
    const out: Row[] = [];
    const list = (label: string, sessions: ProjectSession[], color?: string) => {
      if (sessions.length === 0) return;
      out.push({ kind: "head", label, count: sessions.length, ...(color ? { color } : {}) });
      for (const s of sessions) out.push({ kind: "session", s, project: name(s) });
    };
    list("Needs you", sections.needs, t().warn);
    list("Working", sections.working, t().accent);
    list("Pinned", sections.pinned);
    for (const g of groupByProject(overview, opts)) {
      out.push({ kind: "head", label: g.workspace.name, count: g.sessions.length });
      for (const s of g.sessions.slice(0, g.current ? PER_PROJECT : PER_OTHER)) out.push({ kind: "session", s });
    }
    return out;
  });
  const sessionRows = createMemo(() => rows().flatMap((r, i) => (r.kind === "session" ? [i] : [])));
  const [sel, setSel] = createSignal(0);
  createEffect(() => {
    if (!p.active) return;
    const at = rows().findIndex((r) => r.kind === "session" && isActive(r.s));
    setSel(Math.max(0, sessionRows().indexOf(at)));
  });

  useKeyboard((key) => {
    if (!p.active || key.defaultPrevented) return;
    const n = sessionRows().length;
    if (key.name === "escape") {
      key.preventDefault();
      p.onLeave();
    } else if ((key.name === "down" || key.name === "j") && n > 0) {
      key.preventDefault();
      setSel((i) => Math.min(n - 1, i + 1));
    } else if ((key.name === "up" || key.name === "k") && n > 0) {
      key.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (key.name === "return") {
      key.preventDefault();
      const row = rows()[sessionRows()[sel()] ?? -1];
      if (row?.kind === "session") void app.openSession(row.s).then(p.onOpened);
    }
  });

  const selectedRow = () => sessionRows()[sel()] ?? -1;
  /** Inside the borders and padding, after the two-column mark. */
  const width = () => p.width - 5;
  const meta = (row: Extract<Row, { kind: "session" }>) => ` ${row.project ? `${clip(row.project, 10)} ` : ""}${age(row.s.updatedAt)}`;

  return (
    <box flexDirection="column" width={p.width} flexShrink={0} border={["right"]} borderColor={t().border} paddingLeft={1} paddingRight={1}>
      <text fg={t().text} flexShrink={0}>
        <b>Sessions</b>
        <span style={{ fg: accentOf(t(), app.harness()?.accent) }}>{`  ${app.harness()?.displayName ?? ""}`}</span>
      </text>
      <text fg={t().muted} wrapMode="none" truncate flexShrink={0}>
        {app.workspace()?.path ?? "no project"}
      </text>
      <scrollbox flexGrow={1} marginTop={1} verticalScrollbarOptions={{ visible: false }}>
        <For each={rows()}>
          {(row, i) =>
            row.kind === "head" ? (
              <text fg={row.color ?? t().muted} marginTop={i() === 0 ? 0 : 1}>
                {`${row.label} `}
                <span style={{ fg: t().muted }}>{String(row.count)}</span>
              </text>
            ) : (
              <box
                flexDirection="row"
                backgroundColor={i() === selectedRow() && p.active ? t().selection : isActive(row.s) ? t().surface2 : undefined}
                onMouseDown={() => void app.openSession(row.s).then(p.onOpened)}
              >
                <text flexShrink={0} fg={row.s.asking ? t().warn : isBusy(row.s.status) ? t().accent : row.s.liveChatId ? t().ok : t().muted}>
                  {row.s.asking ? "▲ " : isBusy(row.s.status) ? `${SPINNER[tick() % SPINNER.length]} ` : row.s.liveChatId ? "● " : "· "}
                </text>
                <text flexGrow={1} fg={isActive(row.s) ? t().text : t().text2} wrapMode="none">
                  {clip(row.s.title || "New chat", width() - meta(row).length)}
                </text>
                <text flexShrink={0} fg={t().muted}>
                  {meta(row)}
                </text>
              </box>
            )
          }
        </For>
        <Show when={rows().length === 0}>
          <text fg={t().muted}>No sessions yet</text>
        </Show>
      </scrollbox>
      <text fg={t().muted} flexShrink={0}>
        {p.active ? "↑↓ Enter · Esc back" : "^X S to browse"}
      </text>
    </box>
  );
}
