// A message's actions as a phone's bottom sheet: what a long press on a prompt
// or an answer opens (Retry, Edit, Copy, Fork, …), in rows a thumb can hit.
import { Dialog } from "./Dialog.js";

export interface SheetAction {
  label: string;
  icon?: React.ReactNode;
  run: () => void;
}

export function ActionSheet({ title, actions, onClose }: { title: string; actions: SheetAction[]; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} className="action-sheet">
      <ul className="action-sheet-list" role="menu">
        {actions.map((a) => (
          <li key={a.label} role="none">
            <button
              type="button"
              role="menuitem"
              className="action-sheet-item"
              onClick={() => {
                onClose();
                a.run();
              }}
            >
              {a.icon ? <span className="action-sheet-icon">{a.icon}</span> : null}
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
