// The file viewer: one of the project's files, read-only, in a sheet on the
// right (Review's). Coloured for its language (highlight.ts), with line
// numbers, the lines this chat's edits added marked in the gutter, and a line
// to point at: a click on its number marks it, and Mention puts `@path:line`
// into your message. "Go to file" at the top finds another by name. The server
// shows only the project's own files (what git tracks or does not ignore),
// bounded (file-view.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileView, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { addToDraft } from "../draft-bus.js";
import type { FileRequest } from "../file-bus.js";
import { highlightLines, languageOf } from "../highlight.js";
import { IconCheck, IconCopy, IconFile, IconSearch, IconX, Spinner } from "../icons.js";
import type { FileChanges } from "../review.js";
import { DiffBadge } from "./ToolBody.js";
import { Markdown } from "./Markdown.js";
import { previewKind } from "../preview.js";

/** Rows drawn per block; a block off screen is skipped by the browser (content-visibility). */
const CHUNK = 200;
/** Past this many lines, the file shows uncoloured: colouring it would stall the page. */
const MAX_COLOURED = 20_000;

const LANGUAGE_NAMES: Record<string, string> = {
  js: "JavaScript/TypeScript",
  json: "JSON",
  py: "Python",
  rs: "Rust",
  go: "Go",
  c: "C-family",
  sh: "Shell",
  nix: "Nix",
  yaml: "YAML",
  toml: "TOML",
  css: "CSS",
  html: "HTML/XML",
  sql: "SQL",
  lua: "Lua",
  rb: "Ruby",
  md: "Markdown",
};

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The lines this chat's edits added to `path`, by their number in the edit's result. */
function addedLines(changes: FileChanges | undefined): Set<number> {
  const out = new Set<number>();
  for (const edit of changes?.edits ?? []) for (const l of edit.tool.diff?.lines ?? []) if (l.kind === "add" && l.line !== undefined) out.add(l.line);
  return out;
}

/** "Go to file": the project's files matching what is typed, from the @mention list. */
function GoToFile({ workspace, onPick, autoFocus }: { workspace: WorkspaceInfo; onPick: (path: string) => void; autoFocus: boolean }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFound([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      api<{ files: string[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/files?q=${encodeURIComponent(q)}`).then(
        (r) => {
          if (!live) return;
          setFound(r.files.slice(0, 12));
          setActive(0);
        },
        () => live && setFound([]),
      );
    }, 90);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, workspace.id]);
  const pick = (path: string) => {
    onPick(path);
    setQuery("");
    setOpen(false);
  };
  return (
    <div className="viewer-goto">
      <label className="viewer-goto-box">
        <IconSearch size={13} />
        <input
          type="search"
          autoFocus={autoFocus}
          aria-label="Go to file"
          placeholder="Go to file…"
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, Math.min(found.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            } else if (e.key === "Enter" && found[active]) {
              e.preventDefault();
              pick(found[active] as string);
            }
          }}
        />
      </label>
      {open && found.length > 0 ? (
        <ul className="viewer-goto-list" role="listbox" aria-label="Files">
          {found.map((f, i) => {
            const cut = f.lastIndexOf("/") + 1;
            return (
              <li
                key={f}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : undefined}
                onPointerMove={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(f);
                }}
              >
                <IconFile size={12} />
                <span className="viewer-goto-name">{f.slice(cut)}</span>
                <span className="viewer-goto-dir">{f.slice(0, cut)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function FileViewer({ workspace, request, changes, onClose }: { workspace: WorkspaceInfo; request: FileRequest | null; changes: FileChanges[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const code = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<FileRequest | null>(request);
  const [marked, setMarked] = useState<number | null>(request?.line ?? null);
  const [file, setFile] = useState<{ path: string; view: FileView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The path shown rendered rather than as source (the toggle): keyed by path, so
  // another file opens as source.
  const [rendered, setRendered] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  // Another link clicked while it is open: that file, that line.
  useEffect(() => {
    if (!request) return;
    setShown(request);
    setMarked(request.line ?? null);
  }, [request]);

  useEffect(() => {
    if (!shown) return;
    let live = true;
    setError(null);
    api<FileView>(`/api/workspaces/${encodeURIComponent(workspace.id)}/file?path=${encodeURIComponent(shown.path)}`).then(
      (view) => live && setFile({ path: shown.path, view }),
      (e: unknown) => {
        if (!live) return;
        setFile(null);
        setError(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [shown, workspace.id]);

  const view = file?.view ?? null;
  const loading = shown !== null && !error && file?.path !== shown.path;
  const language = view ? languageOf(view.path) : null;
  const lines = useMemo(() => {
    if (!view?.text && view?.text !== "") return [];
    const text = view.text.endsWith("\n") ? view.text.slice(0, -1) : view.text;
    return highlightLines(text, view.lines <= MAX_COLOURED ? language : null);
  }, [view, language]);
  const mine = changes.find((c) => c.path === view?.path);
  const added = useMemo(() => addedLines(mine), [mine]);
  const chunks = useMemo(() => Array.from({ length: Math.ceil(lines.length / CHUNK) }, (_, i) => i * CHUNK), [lines.length]);

  // The asked-for line, brought to the middle once its file is drawn.
  useEffect(() => {
    if (loading || !view || !shown?.line) return;
    window.requestAnimationFrame(() => code.current?.querySelector(`[data-line="${shown.line}"]`)?.scrollIntoView({ block: "center" }));
  }, [loading, view, shown]);

  const path = view?.path ?? shown?.path ?? "";
  const preview = view ? previewKind(view.path) : null;
  const showPreview = preview === "markdown" && rendered === path && Boolean(view?.text) && !view?.binary;
  const cut = path.lastIndexOf("/") + 1;
  const mention = () => {
    addToDraft(`@${path}${marked ? `:${marked}` : ""}`);
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="viewer"
      aria-label={path ? `File ${path}` : "Open a file"}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="viewer-body">
        <header className="viewer-head">
          <div className="viewer-title">
            <IconFile size={15} />
            {path ? (
              <h2 title={path}>
                <span className="viewer-dir">{path.slice(0, cut)}</span>
                <span className="viewer-name">{path.slice(cut)}</span>
              </h2>
            ) : (
              <h2>Open a file</h2>
            )}
          </div>
          <GoToFile
            workspace={workspace}
            autoFocus={shown === null}
            onPick={(p) => {
              setShown({ path: p });
              setMarked(null);
            }}
          />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        {view ? (
          <div className="viewer-meta">
            {language ? <span className="viewer-chip">{LANGUAGE_NAMES[language] ?? language}</span> : null}
            <span className="viewer-chip">{view.lines === 1 ? "1 line" : `${view.lines.toLocaleString()} lines`}</span>
            <span className="viewer-chip">{bytes(view.size)}</span>
            {mine ? (
              <span className="viewer-chip is-changed" title="The lines this chat's edits added are marked">
                Changed in this chat <DiffBadge added={mine.added} removed={mine.removed} />
              </span>
            ) : null}
            <span className="viewer-actions">
              {preview === "markdown" ? (
                <span className="viewer-toggle" role="group" aria-label="View">
                  <button type="button" aria-pressed={!showPreview} onClick={() => setRendered(null)}>
                    Code
                  </button>
                  <button type="button" aria-pressed={showPreview} onClick={() => setRendered(path)}>
                    Preview
                  </button>
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() =>
                  void navigator.clipboard?.writeText(path).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  })
                }
              >
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />} {copied ? "Copied" : "Copy path"}
              </button>
              <button type="button" className="btn btn-small btn-primary" onClick={mention} title="Put this file, or the marked line, into your message">
                Mention {marked ? `line ${marked}` : "file"}
              </button>
            </span>
          </div>
        ) : null}
        <div className={`viewer-code${showPreview ? " is-prose" : ""}`} ref={code} role="region" aria-label={path ? `Contents of ${path}` : "File"} aria-busy={loading}>
          {shown === null ? (
            <p className="viewer-empty muted">Type a name above to open one of the project's files.</p>
          ) : error ? (
            <p className="viewer-empty is-error">{error}</p>
          ) : loading || !view ? (
            <p className="viewer-empty muted">
              <Spinner size={13} /> Opening…
            </p>
          ) : showPreview ? (
            <div className="viewer-prose">
              <Markdown text={view.text ?? ""} />
            </div>
          ) : view.binary ? (
            <p className="viewer-empty muted">A binary file ({bytes(view.size)}): nothing to show as text.</p>
          ) : (
            <>
              {chunks.map((from) => (
                <div key={from} className="vl-chunk" style={{ ["--rows" as string]: Math.min(CHUNK, lines.length - from) }}>
                  {lines.slice(from, from + CHUNK).map((tokens, i) => {
                    const n = from + i + 1;
                    return (
                      <div key={n} data-line={n} className={`vl${added.has(n) ? " is-added" : ""}${marked === n ? " is-marked" : ""}`}>
                        <button type="button" className="vl-num" aria-label={`Line ${n}`} aria-pressed={marked === n} onClick={() => setMarked(marked === n ? null : n)}>
                          {n}
                        </button>
                        <span className="vl-text">
                          {tokens.map((t, k) =>
                            t.kind === "plain" ? (
                              t.text
                            ) : (
                              <span key={k} className={`tk-${t.kind}`}>
                                {t.text}
                              </span>
                            ),
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {view.truncated ? <p className="viewer-cut muted">The rest of the file ({bytes(view.size)} in all) is not shown.</p> : null}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
