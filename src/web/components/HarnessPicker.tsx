// Harness switcher in the composer bar: the current harness chip opens a menu
// of the other available harnesses; picking one hands the chat off. Idle chats
// move immediately; busy chats stop first and carry the composer draft as the
// target's first prompt (stop-here-continue-there).
import { useRef, useState } from "react";
import type { HarnessStatus } from "../../shared/protocol.js";
import { useDismiss } from "../hooks.js";
import { IconChevronDown } from "../icons.js";
export function HarnessPicker({
  harnesses,
  currentId,
  disabled,
  onHandoff,
}: {
  harnesses: HarnessStatus[];
  currentId: string;
  disabled: boolean;
  onHandoff: (harnessId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(wrap, open, () => setOpen(false), { escape: true });
  const current = harnesses.find((h) => h.id === currentId);
  const others = harnesses.filter((h) => h.id !== currentId && h.available && h.capabilities.supportsHandoff);

  return (
    <div className="harness-picker" ref={wrap}>
      <button
        type="button"
        className="pill-select harness-chip"
        aria-label="Harness"
        title={others.length > 0 ? "Hand off to another harness" : "No other harness available"}
        disabled={disabled || others.length === 0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`badge badge-${currentId}`}>{current?.displayName ?? currentId}</span>
        <IconChevronDown size={12} />
      </button>
      {open ? (
        <div className="command-menu harness-menu" role="listbox" aria-label="Hand off to">
          {others.map((h) => (
            <div key={h.id} role="option" aria-selected="false">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onHandoff(h.id);
                }}
              >
                <span className="command-name">Handoff to {h.displayName}</span>
                <span className="command-desc">Continue this session in {h.displayName}</span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
