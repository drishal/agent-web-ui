// A session that a herdr pane runs, opened here: its harness already has the
// session file open there, so resuming it here would be a second writer on
// it. Show that pane in herdr instead (only from this machine: the server
// refuses herdr's controls to other devices), or open it here anyway.
import { useState } from "react";
import type { ProjectSession } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";

const STATUS: Record<NonNullable<ProjectSession["herdr"]>["status"], string> = {
  working: "working",
  blocked: "waiting for an answer",
  done: "finished",
  idle: "idle",
  unknown: "running",
};

export function HerdrDialog({
  session,
  harnessName,
  local,
  onOpenHere,
  onClose,
}: {
  session: ProjectSession & { herdr: NonNullable<ProjectSession["herdr"]> };
  harnessName: string;
  /** This browser is on the server's machine, where herdr runs. */
  local: boolean;
  onOpenHere: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/herdr/focus", { body: { paneId: session.herdr.paneId } });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Open in herdr" onClose={onClose} className="herdr-dialog">
      <p className="herdr-dialog-text">
        <strong>{session.title || "This session"}</strong> runs in herdr, pane <code>{session.herdr.paneId}</code> ({STATUS[session.herdr.status]}). Opening it here as well starts a
        second {harnessName} on the same session, and both would write to it.
      </p>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            onClose();
            onOpenHere();
          }}
        >
          Open here anyway
        </button>
        {local ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void show()}>
            Show in herdr
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}
