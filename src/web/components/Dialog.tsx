import { useEffect, useRef } from "react";
import { useSwipeDown } from "../gestures.js";

/**
 * Native modal <dialog>: focus trap, Escape, and inert background for free.
 * On a phone it is a bottom sheet (styles/phones.css): a handle on top, and a drag
 * down on the handle or the title closes it.
 */
export function Dialog({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLDivElement>(null);
  useSwipeDown(grip, body, onClose);
  // A sheet opened by a long press must not close on the tap the browser may send when the finger lifts.
  const openedAt = useRef(Date.now());
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${className ? ` ${className}` : ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && Date.now() - openedAt.current > 350) onClose();
      }}
    >
      <div className="dialog-body" ref={body}>
        <div ref={grip} className="sheet-grip">
          <div className="sheet-handle" aria-hidden="true" />
          <header className="dialog-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </header>
        </div>
        {children}
      </div>
    </dialog>
  );
}
