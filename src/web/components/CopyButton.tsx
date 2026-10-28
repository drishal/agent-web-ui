// The copy button under a prompt and an answer: the icon blurs and shrinks away as a check comes in, holds a
// moment, and goes back. It is one component so every copy says the same things: its name turns into the done
// name ("Copied") and back, a failed copy says so, and a polite live region announces both (the swap of an
// aria-label alone is not spoken). The morph's look is in controls.css (.copy-btn); reduced motion makes it a swap.
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "../icons.js";

type CopyState = "idle" | "done" | "failed";

const HOLD_MS = 1500;

export function CopyButton({
  label,
  doneLabel = "Copied",
  title,
  icon,
  onCopy,
}: {
  /** The button's name at rest ("Copy reply"). */
  label: string;
  /** Its name for a moment after a copy. */
  doneLabel?: string;
  title?: string;
  /** The icon at rest, already sized. */
  icon: React.ReactNode;
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
        className="ghost-icon copy-btn"
        data-state={state}
        aria-label={state === "done" ? doneLabel : state === "failed" ? "Copy failed" : label}
        title={title}
        onClick={() => void onCopy()?.then(
          () => flash("done"),
          () => flash("failed"),
        )}
      >
        <span className="copy-glyph is-rest" aria-hidden="true">
          {icon}
        </span>
        <span className="copy-glyph is-after" aria-hidden="true">
          {state === "failed" ? <IconX size={14} /> : <IconCheck size={14} />}
        </span>
      </button>
      <span className="copy-live" role="status">
        {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </>
  );
}
