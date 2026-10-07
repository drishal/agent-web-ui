// Review: every file the agent edited or wrote in this chat, each edit's diff
// in order, and comments on any line. The comments are kept per chat on this
// device until they are sent, then go to the agent as one prompt.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatItem, DiffLine } from "../../shared/protocol.js";
import { IconX } from "../icons.js";
import { collectChanges, commentable, commentKey, reviewPrompt, type ReviewComment } from "../review.js";
import { load, save } from "../storage.js";
import { DiffBadge, DiffView } from "./ToolBody.js";

interface Editing {
  key: string;
  path: string;
  line: DiffLine;
  text: string;
}

function NoteEditor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="review-note is-editing">
      <textarea
        className="input review-input"
        autoFocus
        rows={3}
        aria-label="Comment"
        placeholder="What should change here?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) {
            e.preventDefault();
            onSave(text);
          }
        }}
      />
      <div className="review-note-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" disabled={!text.trim()} onClick={() => onSave(text)}>
          Comment
        </button>
      </div>
    </div>
  );
}

export function ReviewPanel({
  chatId,
  items,
  workspace,
  sendLabel,
  sendBlocked,
  onSend,
  onClose,
}: {
  chatId: string;
  items: ChatItem[];
  workspace: string;
  /** "Send", or "Send as follow-up" while the agent works. */
  sendLabel: string;
  /** Why the comments cannot go now. */
  sendBlocked: string | null;
  onSend: (prompt: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const files = useMemo(() => collectChanges(items, workspace), [items, workspace]);
  const storageKey = `review.${chatId}`;
  const [comments, setComments] = useState<ReviewComment[]>(() => load<ReviewComment[]>(storageKey, []));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  useEffect(() => save(storageKey, comments.length > 0 ? comments : null), [storageKey, comments]);

  const byKey = new Map(comments.map((c) => [c.key, c]));
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  /** File order, then edit order, then line: how the prompt lists them. */
  const ordered = () => {
    const rank = new Map<string, number>();
    let n = 0;
    for (const f of files) for (const e of f.edits) for (let i = 0; i < (e.tool.diff?.lines.length ?? 0); i++) rank.set(commentKey(e.tool.id, i), n++);
    return [...comments].sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
  };

  const saveNote = (e: Editing, text: string) => {
    setComments((list) => [...list.filter((c) => c.key !== e.key), { key: e.key, path: e.path, line: e.line, text: text.trim() }]);
    setEditing(null);
  };

  const send = async () => {
    setSending(true);
    const ok = await onSend(reviewPrompt(ordered()));
    setSending(false);
    if (ok) {
      setComments([]);
      onClose();
    }
  };

  return (
    <dialog
      ref={ref}
      className="review"
      aria-label="Review changes"
      onCancel={(e) => {
        e.preventDefault();
        if (editing) setEditing(null);
        else onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="review-body">
        <header className="review-head">
          <div>
            <h2>Review changes</h2>
            <p className="muted">
              {files.length} {files.length === 1 ? "file" : "files"} <DiffBadge added={added} removed={removed} /> · click a line to comment
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        <div className="review-files">
          {files.length === 0 ? <p className="review-empty muted">The agent has not edited any files in this chat.</p> : null}
          {files.map((f) => (
            <section key={f.path} className="review-file" data-testid="review-file">
              <h3 className="review-path">
                <code>{f.path}</code>
                <DiffBadge added={f.added} removed={f.removed} />
              </h3>
              {f.edits.map(({ tool, turn }) => {
                if (!tool.diff) return null;
                const notes = new Map<number, React.ReactNode>();
                tool.diff.lines.forEach((line, i) => {
                  const key = commentKey(tool.id, i);
                  if (editing?.key === key) {
                    notes.set(i, <NoteEditor key="edit" initial={editing.text} onSave={(text) => saveNote(editing, text)} onCancel={() => setEditing(null)} />);
                  } else {
                    const c = byKey.get(key);
                    if (c) {
                      notes.set(
                        i,
                        <div className="review-note" key="note">
                          <p>{c.text}</p>
                          <div className="review-note-actions">
                            <button type="button" className="link-btn" onClick={() => setEditing({ key, path: c.path, line: c.line, text: c.text })}>
                              Edit
                            </button>
                            <button type="button" className="link-btn" onClick={() => setComments((list) => list.filter((x) => x.key !== key))}>
                              Remove
                            </button>
                          </div>
                        </div>,
                      );
                    }
                  }
                });
                return (
                  <div key={tool.id} className="review-edit">
                    <div className="review-edit-head muted">
                      {turn > 0 ? `Turn ${turn} · ` : ""}
                      {tool.name}
                    </div>
                    <DiffView
                      diff={tool.diff}
                      expanded
                      notes={notes}
                      onLine={(i, line) => {
                        if (!commentable(line)) return;
                        const key = commentKey(tool.id, i);
                        setEditing({ key, path: f.path, line, text: byKey.get(key)?.text ?? "" });
                      }}
                    />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <footer className="review-foot">
          <span className="muted">
            {comments.length === 0 ? "No comments yet" : `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}
          </span>
          {comments.length > 0 ? (
            <button type="button" className="btn btn-small" onClick={() => setComments([])}>
              Clear
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={comments.length === 0 || sending || sendBlocked !== null}
            title={sendBlocked ?? undefined}
            onClick={() => void send()}
          >
            {sendLabel}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
