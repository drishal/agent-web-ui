// Search in project (T3 Code's content search): the project's lines holding a
// text, grouped by file, from the server's bounded `git grep` (fixed strings,
// never a pattern). A result goes into the message as `@path:line`, so the
// agent can be pointed at it; Alt+Enter (or a file's name) opens it in the
// file viewer instead. Ctrl+Shift+F or the palette opens it. Results
// render a window at a time: a long list of matches would stall the page.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSearch as SearchResult, SearchMatch, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { addToDraft } from "../draft-bus.js";
import { openFile } from "../file-bus.js";
import { findOffsets } from "../find.js";
import { Dialog } from "./Dialog.js";

const WINDOW = 80;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The line with each occurrence of `q` marked. */
function Marked({ text, q }: { text: string; q: string }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const start of findOffsets(text, q)) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, start + q.length)}</mark>);
    at = start + q.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function ProjectSearch({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [result, setResult] = useState<{ q: string; data: SearchResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(WINDOW);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    setShown(WINDOW);
    setActive(0);
    if (q.length < 2) {
      setResult(null);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      setBusy(true);
      api<SearchResult>(`/api/workspaces/${encodeURIComponent(workspace.id)}/search?q=${encodeURIComponent(q)}&case=${matchCase ? 1 : 0}`).then(
        (data) => {
          if (mine !== seq.current) return;
          setResult({ q, data });
          setError(null);
          setBusy(false);
        },
        (e: unknown) => {
          if (mine !== seq.current) return;
          setError(errorText(e));
          setBusy(false);
        },
      );
    }, 180);
    return () => window.clearTimeout(t);
  }, [query, matchCase, workspace.id]);

  // While a newer query is on its way, the results on show belong to the last one: picking one would mislead.
  const stale = result !== null && result.q !== query.trim();
  const matches = result?.data.matches ?? [];
  const visible = matches.slice(0, shown);
  const groups = useMemo(() => {
    const out: Array<{ path: string; rows: Array<{ m: SearchMatch; i: number }> }> = [];
    visible.forEach((m, i) => {
      const last = out[out.length - 1];
      if (last && last.path === m.path) last.rows.push({ m, i });
      else out.push({ path: m.path, rows: [{ m, i }] });
    });
    return out;
  }, [visible]);

  const pick = (m: SearchMatch) => {
    addToDraft(`@${m.path}:${m.line}`);
    onClose();
  };

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Dialog title="Search in project" onClose={onClose} className="search-dialog">
      <div className="search-head">
        <input
          className="search-input"
          type="search"
          autoFocus
          aria-label="Search the project's files"
          placeholder={`Search ${workspace.name}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // A search box's first Escape would only clear it; here Escape closes, as in the palette.
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const last = visible.length - 1;
              const next = Math.max(0, Math.min(last, active + (e.key === "ArrowDown" ? 1 : -1)));
              if (next === last && shown < matches.length) setShown((n) => n + WINDOW);
              setActive(next);
            } else if (e.key === "Enter" && !stale) {
              const m = visible[active];
              if (m) {
                e.preventDefault();
                if (e.altKey) {
                  openFile({ path: m.path, line: m.line });
                  onClose();
                } else pick(m);
              }
            }
          }}
        />
        <label className="search-case">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
        </label>
      </div>
      <p className="search-status muted" role="status">
        {error
          ? error
          : query.trim().length < 2
            ? "Type two characters or more. Enter puts the line into your message as @path:line; Alt+Enter opens it."
            : busy || stale
              ? "Searching…"
              : matches.length === 0
                ? "No matches"
                : `${matches.length}${result?.data.truncated ? "+" : ""} ${matches.length === 1 ? "match" : "matches"} in ${plural(new Set(matches.map((m) => m.path)).size, "file")}`}
      </p>
      <div className={`search-results${stale ? " is-stale" : ""}`} ref={list} role="listbox" aria-label="Matches">
        {groups.map((g) => (
          <div key={g.path} className="search-file" role="group" aria-label={g.path}>
            <div className="search-path">
              <button
                type="button"
                className="file-link"
                title={`Open ${g.path}`}
                onClick={() => {
                  openFile({ path: g.path, line: g.rows[0]?.m.line ?? 1 });
                  onClose();
                }}
              >
                {g.path}
              </button>
            </div>
            {g.rows.map(({ m, i }) => (
              <div
                key={`${m.path}:${m.line}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className={`search-row${i === active ? " is-active" : ""}`}
                onPointerMove={() => setActive(i)}
                onClick={() => !stale && pick(m)}
              >
                <span className="search-line">{m.line}</span>
                <span className="search-text">
                  <Marked text={m.text} q={result?.q ?? ""} />
                </span>
              </div>
            ))}
          </div>
        ))}
        {shown < matches.length ? (
          <button type="button" className="btn btn-small btn-ghost search-more" onClick={() => setShown((n) => n + WINDOW)}>
            Show {Math.min(WINDOW, matches.length - shown)} more
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}
