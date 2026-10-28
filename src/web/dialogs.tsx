// The two modal dialogs App opens: renaming the chat and pairing a phone.
import { useState } from "react";
import { Dialog } from "./components/Dialog.js";
import { CopyButton } from "./components/CopyButton.js";

export function RenameDialog({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Dialog title="Rename chat" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void onSave(name.trim());
        }}
      >
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Chat name" autoFocus maxLength={200} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function PairDialog({ urls, username, onClose }: { urls: string[]; username: string | null; onClose: () => void }) {
  return (
    <Dialog title="Pair a phone" onClose={onClose}>
      {urls.length > 0 ? (
        <>
          <p>
            Open one of these on your phone and sign in{username ? ` as “${username}”` : ""}. The session lasts 30 days; changing the password
            with <code>npm run set-password</code> signs every device out.
          </p>
          {urls.map((u) => (
            <div key={u} className="pair-url">
              <code>{u}</code>
              <CopyButton className="btn btn-small" label="Copy" text="Copy" onCopy={() => navigator.clipboard?.writeText(u)} />
            </div>
          ))}
          <p className="muted">LAN addresses are plain HTTP: prefer Tailscale when you are away from home.</p>
        </>
      ) : (
        <p>
          Other devices are off. Set a login with <code>npm run set-password</code>, then restart with <code>HOST=0.0.0.0</code> for your LAN,
          or with <code>ALLOWED_HOSTS=&lt;machine&gt;.&lt;tailnet&gt;.ts.net</code> plus{" "}
          <code>tailscale serve --bg http://127.0.0.1:4783</code> for Tailscale.
        </p>
      )}
    </Dialog>
  );
}
