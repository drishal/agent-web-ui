// A file's hover preview: the first lines of the project file a link names,
// coloured like the viewer, with its size and line count. It reads through the
// file viewer's own route (bounded, confined to the project's files), once per
// path for a little while, and shows nothing for a file that cannot be read.
import { useEffect, useRef, useState } from "react";
import type { FileView } from "../../shared/protocol.js";
import { api } from "../api.js";
import { highlightLines, languageOf } from "../highlight.js";
import { useCardPlace } from "../hover-card.js";

/** Lines shown. */
export const PREVIEW_LINES = 12;
/** A cached read is reused this long, so an edit the agent makes shows up on the next rest. */
const FRESH_MS = 30_000;

const cache = new Map<string, { at: number; read: Promise<FileView | null> }>();

function read(workspace: string, path: string): Promise<FileView | null> {
  const key = `${workspace}\0${path}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.read;
  const next = { at: Date.now(), read: api<FileView>(`/api/workspaces/${encodeURIComponent(workspace)}/file?path=${encodeURIComponent(path)}`).catch(() => null) };
  cache.set(key, next);
  if (cache.size > 100) cache.delete(cache.keys().next().value as string);
  return next.read;
}

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FilePreview({ workspace, path, anchor, id }: { workspace: string; path: string; anchor: DOMRect; id: string }) {
  const [view, setView] = useState<FileView | null | undefined>(undefined);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void read(workspace, path).then((v) => live && setView(v));
    return () => {
      live = false;
    };
  }, [workspace, path]);
  const { left, top } = useCardPlace(card, anchor, "below", [view]);
  // Nothing to say until the read answers, and nothing at all when it fails.
  if (!view) return null;
  const shown = view.text === null ? null : view.text.split("\n").slice(0, PREVIEW_LINES).join("\n");
  const lines = shown === null ? [] : highlightLines(shown, languageOf(view.path));
  return (
    <div ref={card} id={id} role="tooltip" className="file-preview" style={{ left, top }}>
      <div className="file-preview-head">
        <span className="file-preview-path">{view.path}</span>
        <span className="file-preview-meta">{view.binary ? bytes(view.size) : `${view.lines} ${view.lines === 1 ? "line" : "lines"} · ${bytes(view.size)}`}</span>
      </div>
      {shown === null ? (
        <div className="file-preview-note muted">Binary file</div>
      ) : shown === "" ? (
        <div className="file-preview-note muted">Empty file</div>
      ) : (
        <pre className="file-preview-code">
          {lines.map((tokens, i) => (
            <div className="file-preview-line" key={i}>
              {tokens.length === 0
                ? " "
                : tokens.map((t, k) => (
                    <span key={k} className={`tk-${t.kind}`}>
                      {t.text}
                    </span>
                  ))}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
