// Snooze a session until a time the user picks (T3 Code's Snooze → Custom…):
// the day a limit resets, or the work is due again. The marks route already
// refuses a time in the past; this checks first so the dialog can say so.
import { useState } from "react";
import { snoozeInputAt, snoozeInputDefault } from "../session-groups.js";
import { Dialog } from "./Dialog.js";

export function SnoozeUntil({ onPick, onClose }: { onPick: (at: number) => void; onClose: () => void }) {
  const [value, setValue] = useState(snoozeInputDefault);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Snooze until" onClose={onClose}>
      <form
        className="snooze-form"
        onSubmit={(e) => {
          e.preventDefault();
          const at = snoozeInputAt(value);
          if (at === null) {
            setError("Pick a time in the future");
            return;
          }
          onPick(at);
        }}
      >
        <label htmlFor="snooze-at">Wake it at</label>
        <input
          id="snooze-at"
          type="datetime-local"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {error ? (
          <p className="snooze-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="snooze-hint">It comes back then, or as soon as it fails or asks for you.</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Snooze
          </button>
        </div>
      </form>
    </Dialog>
  );
}
