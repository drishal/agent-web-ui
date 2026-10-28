// The copy button under a prompt and an answer: the icon blurs and shrinks away as a check comes in, holds a
// moment, and goes back. It is one component so every copy says the same things: its name turns into the done
// name ("Copied") and back, a failed copy says so, and a polite live region announces both (the swap of an
// aria-label alone is not spoken). The morph's look is in controls.css (.copy-btn); reduced motion makes it a swap.
// Icon-only by default; `text` makes it a labelled button (the file viewer's Copy path, a sheet's Copy) whose
// visible words swap with the same state, and `icon` may be left out for a words-only one (Copy JSON).
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "../icons.js";

type CopyState = "idle" | "done" | "failed";

const HOLD_MS = 1500;

export function CopyButton({
  label,
  doneLabel = "Copied",
  title,
  icon,
  iconSize = 14,
  className = "ghost-icon",
  text,
  onCopy,
}: {
  /** The button's name at rest ("Copy reply"). */
  label: string;
  /** Its name for a moment after a copy. */
  doneLabel?: string;
  title?: string;
  /** The icon at rest, already sized (to `iconSize`, which sizes the check that replaces it). */
  icon?: React.ReactNode;
  iconSize?: number;
  /** The button's classes besides copy-btn. */
  className?: string;
  /** Visible words beside the icon at rest ("Copy path"); they read the done name for a moment. */
  text?: string;
  /** Writes to the clipboard; undefined when there is no clipboard (nothing to wait for), a rejection when it was refused. */
  onCopy: () => Promise<void> | undefined;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = (next: CopyState) => {
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), HOLD_MS);
  };
  return (
    <>
      <button
        type="button"
        className={`${className} copy-btn`}
        data-state={state}
        aria-label={state === "done" ? doneLabel : state === "failed" ? "Copy failed" : label}
        title={title}
        onClick={() => void onCopy()?.then(
          () => flash("done"),
          () => flash("failed"),
        )}
      >
        {icon ? (
          <span className="copy-icons" aria-hidden="true">
            <span className="copy-glyph is-rest">{icon}</span>
            <span className="copy-glyph is-after">{state === "failed" ? <IconX size={iconSize} /> : <IconCheck size={iconSize} />}</span>
          </span>
        ) : null}
        {text ? (
          <span className="copy-text">
            {state === "done" ? doneLabel : state === "failed" ? "Copy failed" : text}
          </span>
        ) : null}
      </button>
      <span className="copy-live" role="status">
        {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </>
  );
}
