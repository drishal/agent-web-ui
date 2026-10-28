// A body that grows open and shrinks shut: a tool card, an opened call, a
// thought. It animates grid rows from 0fr to 1fr (no height is measured, and
// Firefox does it as Chromium does, unlike interpolate-size), and keeps the
// content mounted until it has shrunk, so closing moves as opening does.
// Reduced motion turns the transition off (tokens.css); the timers still end
// the close, since a transition that never runs sends no transitionend.
import { useLayoutEffect, useState, type ReactNode } from "react";

/** How long the grow or shrink takes (motion.css's .collapse), and so when a closed body leaves. */
const COLLAPSE_MS = 240;

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  // Open and done growing: the content may spill (a focus ring, a code block's shadow) instead of being clipped.
  const [settled, setSettled] = useState(open);

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      setSettled(false);
      // The mount paints at 0fr (this effect runs before that paint); the next frame grows it, as a transition, not a jump.
      const frame = requestAnimationFrame(() => setExpanded(true));
      const done = window.setTimeout(() => setSettled(true), COLLAPSE_MS + 40);
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(done);
      };
    }
    setExpanded(false);
    setSettled(false);
    const gone = window.setTimeout(() => setMounted(false), COLLAPSE_MS + 40);
    return () => window.clearTimeout(gone);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className={`collapse${expanded ? " is-open" : ""}${settled ? " is-settled" : ""}`} inert={!open || undefined}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
