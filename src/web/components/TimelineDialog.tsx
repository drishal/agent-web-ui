// The file timeline: the files as they were before each prompt (the chat's
// checkpoints), and as they are now, on one rail; any two of them compared
// file by file, every change's lines shown. A point on the rail is a click:
// before the other end it moves "from", after it "to", and the stretch
// between is lit. From a prompt's point, Undo opens the restore dialog to put
// the files back as they were then.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckpointComparison, CheckpointPoint } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { IconUndo, IconX, Spinner } from "../icons.js";
import { ago } from "../turns.js";
import { FileLink } from "./FileLink.js";
import { DiffBadge, DiffView } from "./ToolBody.js";

type End = number | "now";

const CHANGE_LABEL = { added: "added", deleted: "deleted", modified: "changed" } as const;

export function TimelineDialog({ chatId, onUndo, onClose }: { chatId: string; onUndo: (turn: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [points, setPoints] = useState<CheckpointPoint[] | null>(null);
  const [from, setFrom] = useState<End | null>(null);
  const [to, setTo] = useState<End>("now");
  const [result, setResult] = useState<{ key: string; data: CheckpointComparison } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  useEffect(() => {
    let live = true;
    api<{ points: CheckpointPoint[] }>(`/api/chats/${chatId}/checkpoints`).then(
      (r) => {
        if (!live) return;
        setPoints(r.points);
        // At first: everything this chat changed, from before its first prompt to now.
        setFrom(r.points[0]?.turn ?? null);
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [chatId]);

  const key = `${from}:${to}`;
  useEffect(() => {
    if (from === null) return;
    let live = true;
    api<CheckpointComparison>(`/api/chats/${chatId}/checkpoints/compare?from=${from}&to=${to}`).then(
      (data) => {
        if (!live) return;
        setResult({ key, data });
        setError(null);
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [chatId, key]);

  /** Where an end sits on the rail: prompts by number, now last. */
  const order = (e: End) => (e === "now" ? Number.POSITIVE_INFINITY : e);
  const pick = (e: End) => {
    if (from === null) return;
    if (order(e) < order(to)) setFrom(e);
    else if (order(e) > order(from)) setTo(e);
  };
  const ends: End[] = useMemo(() => [...(points ?? []).map((p) => p.turn), "now" as const], [points]);
  const loading = result?.key !== key && !error;
  const files = result?.data.files ?? [];
  const added = files.reduce((n, f) => n + (f.diff?.added ?? 0), 0);
  const removed = files.reduce((n, f) => n + (f.diff?.removed ?? 0), 0);
  const label = (e: End) => (e === "now" ? "now" : `before #${e}`);

  return (
    <dialog
      ref={ref}
      className="review timeline"
      aria-label="File timeline"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="review-body">
        <header className="review-head">
          <div>
            <h2>File timeline</h2>
            <p className="muted">The files before each prompt, and now: pick two points to see what changed between them.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        {points && points.length === 0 ? <p className="review-empty muted">No checkpoints yet: one is taken before each prompt in a git repository.</p> : null}
        {points && points.length > 0 ? (
          <nav className="timeline-rail" aria-label="Points">
            {ends.map((e, i) => {
              const point = e === "now" ? null : points.find((p) => p.turn === e);
              const isFrom = e === from;
              const isTo = e === to;
              const inside = from !== null && order(e) > order(from) && order(e) < order(to);
              return (
                <div key={String(e)} className={`timeline-stop${inside || isTo ? " is-lit" : ""}${i === 0 ? " is-first" : ""}`}>
                  <button
                    type="button"
                    className={`timeline-dot${isFrom ? " is-from" : ""}${isTo ? " is-to" : ""}`}
                    aria-pressed={isFrom || isTo}
                    aria-label={e === "now" ? "Now" : `Before prompt ${e}: ${point?.prompt ?? ""}`}
                    title={point ? `${point.prompt}\n${new Date(point.at).toLocaleString()}` : "The files as they are now"}
                    onClick={() => pick(e)}
                  >
                    {e === "now" ? "Now" : `#${e}`}
                  </button>
                  <span className="timeline-caption">{point ? point.prompt : "the files now"}</span>
                  <span className="timeline-when muted">{point ? ago(point.at) : ""}</span>
                </div>
              );
            })}
          </nav>
        ) : null}
        {from !== null ? (
          <div className="timeline-summary">
            <span>
              From <b>{label(from)}</b> to <b>{label(to)}</b>
              {result && !loading ? (
                <>
                  {" · "}
                  {files.length + (result.data.more ?? 0)} {files.length + result.data.more === 1 ? "file" : "files"} <DiffBadge added={added} removed={removed} />
                </>
              ) : null}
            </span>
            {loading ? <Spinner size={13} /> : null}
            {typeof from === "number" ? (
              <button type="button" className="btn btn-small" onClick={() => onUndo(from)} title={`Put files back as they were before prompt ${from}`}>
                <IconUndo size={13} /> Undo to before #{from}…
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="review-empty is-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className={`review-files${loading ? " is-stale" : ""}`}>
          {result && !loading && files.length === 0 ? <p className="review-empty muted">No file changed between these two points.</p> : null}
          {files.map((f) => (
            <section key={f.path} className="review-file" data-testid="timeline-file">
              <h3 className="review-path">
                <FileLink path={f.path}>
                  <code>{f.path}</code>
                </FileLink>
                <span className={`timeline-change is-${f.change}`}>{CHANGE_LABEL[f.change]}</span>
                {f.diff ? <DiffBadge added={f.diff.added} removed={f.diff.removed} /> : null}
              </h3>
              {f.diff ? <DiffView diff={f.diff} expanded /> : <p className="muted timeline-note">{f.note}</p>}
            </section>
          ))}
          {result && result.data.more > 0 ? <p className="review-empty muted">…and {result.data.more} more files.</p> : null}
        </div>
      </div>
    </dialog>
  );
}
