// A light confirmation: the button's own face turns into "Sure? ✓ ✕" in place
// instead of opening a dialog. The box widens to fit, focus moves to ✓, Enter
// confirms, Escape cancels, and a 4s pause or a blur resets it. For the truly
// irreversible things, HoldButton (hold.ts) asks for longer pressure instead.
import { useEffect, useRef, useState, type ReactNode } from "react";

export function ConfirmButton({
  label,
  confirmLabel = "Sure?",
  onConfirm,
  disabled,
  className = "",
  danger,
  children,
}: {
  /** What the action does, used in the aria-labels ("Delete this prompt"). */
  label: string;
  /** The confirm face's words; keep it short. */
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
  /** Draw the confirm state in danger colours. */
  danger?: boolean;
  /** Icon, if any, drawn before the label. */
  children?: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reset = () => {
    window.clearTimeout(timer.current);
    setAsking(false);
  };

  const arm = () => {
    setAsking(true);
    // Focus the confirm so Enter follows through and Escape backs out.
    requestAnimationFrame(() => yes.current?.focus());
    timer.current = setTimeout(reset, 4000);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!asking) {
    return (
      <button type="button" className={className} disabled={disabled} aria-label={label} onClick={arm}>
        {children}
        {label}
      </button>
    );
  }
  return (
    <span
      className={`confirm-morph${danger ? " is-danger" : ""}`}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && reset()}
      onKeyDown={(e) => {
        // Escape backs the ask out before the dialog's own Escape closes the dialog.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          reset();
        }
      }}
    >
      <span className="confirm-morph-ask" aria-hidden="true">
        {confirmLabel}
      </span>
      <button
        type="button"
        ref={yes}
        className="confirm-morph-yes"
        aria-label={`Confirm: ${label}`}
        onClick={() => {
          reset();
          onConfirm();
        }}
      >
        ✓
      </button>
      <button type="button" className="confirm-morph-no" aria-label={`Cancel: ${label}`} onClick={reset}>
        ✕
      </button>
    </span>
  );
}
