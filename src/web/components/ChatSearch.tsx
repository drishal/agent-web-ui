// Search every chat: what you and the agents said, in every harness and
// project, from the server's bounded search (chat-search.ts). Each chat is one
// result, its first few hits under it with the words marked; picking one
// opens the chat with Find already holding the word, so the first place it
// was said is in view. Ctrl+Shift+H, the palette, or the sidebar's search
// opens it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSearch as SearchResult, ChatSearchHit, ChatSearchResult, HarnessStatus, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { harnessColor } from "../harness-colors.js";
import { IconSearch, IconTerminal } from "../icons.js";
import { ago } from "../turns.js";
import { Dialog } from "./Dialog.js";

const KIND_LABEL: Record<ChatSearchHit["kind"], string> = { title: "Title", prompt: "You", answer: "Reply", tool: "Tool" };

/** A snippet with its matched words marked. */
function Marked({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** The chat's title, its words marked when they are what matched. */
function ResultTitle({ result }: { result: ChatSearchResult }) {
  const named = result.hits.find((h) => h.kind === "title");
  return <span className="chat-result-title">{named ? <Marked text={named.snippet} ranges={named.ranges} /> : result.session.title || "New chat"}</span>;
}

function Hit({ hit }: { hit: ChatSearchHit }) {
  return (
    <div className={`chat-hit chat-hit-${hit.kind}`}>
      <span className="chat-hit-kind">
        {hit.kind === "tool" ? <IconTerminal size={11} /> : null}
        {KIND_LABEL[hit.kind]}
      </span>
      {hit.turn !== null ? <span className="chat-hit-turn">#{hit.turn}</span> : null}
      <span className="chat-hit-text">
        <Marked text={hit.snippet} ranges={hit.ranges} />
      </span>
    </div>
  );
}

export function ChatSearch({
  harnesses,
  initialQuery = "",
  onOpen,
  onClose,
}: {
  harnesses: HarnessStatus[];
  initialQuery?: string;
  /** Open the result's chat (in `workspace`); `word` is what Find should look for there. */
  onOpen: (result: ChatSearchResult, word: string, workspace: WorkspaceInfo | undefined) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [harness, setHarness] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; data: SearchResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const q = query.trim();
  const key = `${harness ?? ""}\u0000${q}`;

  useEffect(() => {
    setActive(0);
    if (q.length < 2) {
      setResult(null);
      setError(null);
      setBusy(false);
      return;
    }
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      setBusy(true);
      const params = new URLSearchParams({ q, ...(harness ? { harnessId: harness } : {}) });
      api<SearchResult>(`/api/sessions/search?${params}`).then(
        (data) => {
          if (mine !== seq.current) return;
          setResult({ key, data });
          setError(null);
          setBusy(false);
        },
        (e: unknown) => {
          if (mine !== seq.current) return;
          setError(errorText(e));
          setBusy(false);
        },
      );
    }, 220);
    return () => window.clearTimeout(t);
  }, [key]);

  // The results on show belong to the last query until the new one lands: picking one then would mislead.
  const stale = result !== null && result.key !== key;
  const results = result?.data.results ?? [];
  const project = useMemo(() => new Map((result?.data.workspaces ?? []).map((w) => [w.id, w.name])), [result]);
  const name = (id: string) => harnesses.find((h) => h.id === id)?.displayName ?? id;
  // The longest word is in every hit; Find in the chat looks for that.
  const word = useMemo(() => [...q.split(/\s+/)].sort((a, b) => b.length - a.length)[0] ?? q, [q]);
  const pick = (r: ChatSearchResult) => {
    onOpen(
      r,
      word,
      result?.data.workspaces.find((w) => w.id === r.session.workspaceId),
    );
    onClose();
  };

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const chats = results.length;
  const status = error
    ? error
    : q.length < 2
      ? "Type two characters or more: every word must be in one message."
      : busy || stale
        ? "Searching…"
        : chats === 0
          ? `Nothing found in ${result?.data.scanned ?? 0} ${result?.data.scanned === 1 ? "chat" : "chats"}`
          : `${chats}${result?.data.truncated ? "+" : ""} ${chats === 1 ? "chat" : "chats"} of ${result?.data.total ?? 0}${result?.data.truncated ? " (stopped early: narrow it down)" : ""}`;

  return (
    <Dialog title="Search every chat" onClose={onClose} className="chat-search-dialog">
      <label className="model-search chat-search-box">
        <IconSearch size={15} />
        <input
          className="chat-search-input"
          type="search"
          autoFocus
          aria-label="Search every chat"
          placeholder="What you or the agent said…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, Math.min(chats - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            } else if (e.key === "Enter" && !stale) {
              const r = results[active];
              if (r) {
                e.preventDefault();
                pick(r);
              }
            }
          }}
        />
      </label>
      <div className="chat-search-filters" role="group" aria-label="Harness">
        <button type="button" className={`filter-chip${harness === null ? " is-on" : ""}`} aria-pressed={harness === null} onClick={() => setHarness(null)}>
          All
        </button>
        {harnesses.map((h) => (
          <button
            key={h.id}
            type="button"
            className={`filter-chip${harness === h.id ? " is-on" : ""}`}
            aria-pressed={harness === h.id}
            style={harnessColor(h.id)}
            onClick={() => setHarness(harness === h.id ? null : h.id)}
          >
            <span className="filter-chip-dot" aria-hidden="true" />
            {h.displayName}
          </button>
        ))}
      </div>
      <p className="search-status muted" role="status">
        {status}
      </p>
      <div className={`chat-search-results${stale ? " is-stale" : ""}`} ref={list} role="listbox" aria-label="Chats found">
        {results.map((r, i) => (
          <div
            key={r.session.id}
            role="option"
            aria-selected={i === active}
            data-index={i}
            className={`chat-result${i === active ? " is-active" : ""}`}
            style={harnessColor(r.session.harnessId)}
            onPointerMove={() => i !== active && setActive(i)}
            onClick={() => !stale && pick(r)}
          >
            <div className="chat-result-head">
              <span className="badge badge-harness">{name(r.session.harnessId)}</span>
              <ResultTitle result={r} />
              <span className="chat-result-meta">
                {[project.get(r.session.workspaceId), r.session.updatedAt ? ago(Date.parse(r.session.updatedAt)) : null].filter(Boolean).join(" · ")}
              </span>
            </div>
            {r.hits
              .filter((h) => h.kind !== "title")
              .map((h, n) => (
                <Hit key={n} hit={h} />
              ))}
            {r.more > 0 ? <div className="chat-hit-more">+{r.more} more in this chat</div> : null}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
