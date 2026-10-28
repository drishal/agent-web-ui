// The saved prompts' manager: the list on the left (with a filter), the one
// picked on the right to rename, rewrite, delete, or put into the message.
// They live on the server, so every device and atui see the same ones; a
// `{{blank}}` in a prompt is a place to fill in when it is used (# in a
// composer, then Tab from blank to blank).
import { useEffect, useMemo, useState } from "react";
import { MAX_SAVED_PROMPT_CHARS, type SavedPrompt } from "../../shared/protocol.js";
import { errorText } from "../api.js";
import { addToDraft } from "../draft-bus.js";
import { IconPlan, IconPlus, IconSearch } from "../icons.js";
import { blanks, matchPrompts, promptGist } from "../prompt-blanks.js";
import { removePrompt, savePrompt, useSavedPrompts } from "../saved-prompts.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { Dialog } from "./Dialog.js";

type Editing = { id: string | null; name: string; text: string };

const fresh = (text = ""): Editing => ({ id: null, name: "", text });

/** The prompt with its blanks shown as chips, for the editor's preview. */
function Preview({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const b of blanks(text)) {
    if (b.start > at) parts.push(text.slice(at, b.start));
    parts.push(
      <span key={b.start} className="blank-chip">
        {b.label || "…"}
      </span>,
    );
    at = b.end;
  }
  parts.push(text.slice(at));
  return <div className="prompt-preview">{parts}</div>;
}

export function SavedPromptsDialog({ draft, onClose }: { draft?: string; onClose: () => void }) {
  const prompts = useSavedPrompts();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing | null>(draft ? fresh(draft) : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => matchPrompts(prompts ?? [], filter.trim()), [prompts, filter]);
  // With nothing picked, the first prompt shows; with none at all, a new one.
  useEffect(() => {
    if (editing || prompts === null) return;
    const first = prompts[0];
    setEditing(first ? { id: first.id, name: first.name, text: first.text } : fresh());
  }, [prompts, editing]);

  const pick = (p: SavedPrompt) => {
    setEditing({ id: p.id, name: p.name, text: p.text });
    setError(null);
  };
  const saved = editing?.id ? prompts?.find((p) => p.id === editing.id) : undefined;
  const changed = editing !== null && (!saved || saved.name !== editing.name.trim() || saved.text !== editing.text);
  const valid = editing !== null && editing.name.trim().length > 0 && editing.text.trim().length > 0;
  const count = editing ? blanks(editing.text).length : 0;

  const save = async () => {
    if (!editing || !valid) return;
    setBusy(true);
    try {
      const p = await savePrompt({ ...(editing.id ? { id: editing.id } : {}), name: editing.name.trim(), text: editing.text });
      setEditing({ id: p.id, name: p.name, text: p.text });
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!editing?.id) return;
    setBusy(true);
    try {
      await removePrompt(editing.id);
      setEditing(null);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Saved prompts" onClose={onClose} className="prompts-dialog">
      <div className="prompts-layout">
        <div className="prompts-side">
          <div className="prompts-side-head">
            <label className="prompts-filter">
              <IconSearch size={13} />
              <input type="search" aria-label="Filter saved prompts" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <button type="button" className="icon-btn" aria-label="New prompt" title="New prompt" onClick={() => setEditing(fresh())}>
              <IconPlus size={15} />
            </button>
          </div>
          <ul className="prompts-list" aria-label="Your saved prompts">
            {prompts === null ? <li className="prompts-none muted">Loading…</li> : null}
            {prompts !== null && shown.length === 0 ? <li className="prompts-none muted">{filter.trim() ? "Nothing matches" : "None yet"}</li> : null}
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" className={`prompts-item${editing?.id === p.id ? " is-active" : ""}`} aria-current={editing?.id === p.id ? "true" : undefined} onClick={() => pick(p)}>
                  <span className="prompts-item-name">#{p.name}</span>
                  <span className="prompts-item-gist">{promptGist(p)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {editing ? (
          <form
            className="prompts-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="prompts-field">
              <span>Name</span>
              <span className="prompts-name-box">
                <span className="prompts-hash" aria-hidden="true">
                  #
                </span>
                <input aria-label="Name" maxLength={80} placeholder="review" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus={editing.id === null} />
              </span>
            </label>
            <label className="prompts-field">
              <span>Prompt</span>
              <textarea
                className="prompts-text"
                aria-label="Prompt"
                rows={9}
                maxLength={MAX_SAVED_PROMPT_CHARS}
                placeholder={"Review {{file}} for {{what to look for}}, and list what to fix first."}
                value={editing.text}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            </label>
            <p className="prompts-hint muted">
              <IconPlan size={12} /> Write <code>{"{{name}}"}</code> where something is filled in each time: <code>#{editing.name.trim() || "name"}</code> in a composer puts the prompt in with
              the first blank selected, and Tab goes to the next.{count > 0 ? ` This one has ${count} ${count === 1 ? "blank" : "blanks"}.` : ""}
            </p>
            {count > 0 ? <Preview text={editing.text} /> : null}
            {error ? (
              <p className="prompts-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="prompts-actions">
              {editing.id ? (
                /* Delete is irreversible enough to ask, but the button asking "Sure?"
                   in place is enough; no dialog. (confirm morph, A3) */
                <ConfirmButton danger label={`Delete the prompt "${editing.name.trim() || "prompt"}"`} disabled={busy} className="btn btn-small btn-ghost prompts-delete" onConfirm={() => void remove()} />
              ) : null}
              <button
                type="button"
                className="btn btn-small"
                disabled={!editing.text.trim()}
                onClick={() => {
                  addToDraft(editing.text);
                  onClose();
                }}
              >
                Put in the message
              </button>
              <button type="submit" className="btn btn-small btn-primary" disabled={!valid || !changed || busy}>
                {editing.id ? (changed ? "Save" : "Saved") : "Save prompt"}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </Dialog>
  );
}
