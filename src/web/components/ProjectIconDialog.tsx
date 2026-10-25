// A project's icon on this device: one or two characters, or Clear for the monogram.
import { useState } from "react";
import { Dialog } from "./Dialog.js";

export function ProjectIconDialog({ name, icon, onSave, onClose }: { name: string; icon: string; onSave: (icon: string | null) => void; onClose: () => void }) {
  const [value, setValue] = useState(icon);
  return (
    <Dialog title={`Icon for ${name}`} onClose={onClose}>
      <form
        className="icon-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
          onClose();
        }}
      >
        <label htmlFor="project-icon">A letter or an emoji (one or two characters)</label>
        <input id="project-icon" className="input icon-input" autoFocus maxLength={2} value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onSave(null);
              onClose();
            }}
          >
            Clear
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
