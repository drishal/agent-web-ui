// Small shared React hooks: the ticker behind live timestamps, and the
// outside-pointerdown / Escape dismissal shared by every popover.
import { useEffect, useRef, useState, type RefObject } from "react";

/** A ticking clock for "2m ago" style labels; paused while `enabled` is false. */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [enabled, intervalMs]);
  return now;
}

export interface DismissOptions {
  /** Close on Escape. Off by default: not every surface is keyboard-dismissed. */
  escape?: boolean;
  /** Close on pointerdown outside `ref`. On by default. */
  outside?: boolean;
}

/**
 * Dismiss an open popover: pointerdown outside the element and, when opted in,
 * Escape. Listeners stay mounted-stable; the latest `onClose` wins via a ref.
 */
export function useDismiss<T extends HTMLElement>(
  ref: RefObject<T | null>,
  open: boolean,
  onClose: () => void,
  { escape = false, outside = true }: DismissOptions = {},
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = outside
      ? (e: PointerEvent) => {
          if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
        }
      : null;
    const onKey = escape
      ? (e: KeyboardEvent) => {
          if (e.key === "Escape") onCloseRef.current();
        }
      : null;
    if (onDown) document.addEventListener("pointerdown", onDown);
    if (onKey) document.addEventListener("keydown", onKey);
    return () => {
      if (onDown) document.removeEventListener("pointerdown", onDown);
      if (onKey) document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, escape, outside]);
}
