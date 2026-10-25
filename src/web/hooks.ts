// Small shared React hooks: the ticker behind live timestamps, and the
// outside-pointerdown / Escape dismissal shared by every popover.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { VIEW_SLIDE_MS, VIEW_SLIDE_OFFSET, viewSlideDirection } from "./view-slide.js";

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

/**
 * Slide a list in when its view changes, from the side the change goes (the
 * sidebar's all-projects list and a focused folder are the two views). Layout
 * timing, so the first painted frame is the slide's start rather than a flash
 * of the new list in place. Scroll goes back to the top with the slide: a
 * folder opens at its newest session, not at wherever the last list was.
 */
export function useViewSlide(ref: RefObject<HTMLElement | null>, view: string): void {
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = view;
    const el = ref.current;
    if (!el || before === null || before === view) return;
    el.scrollTop = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const forward = viewSlideDirection(before, view) === "forward";
    const from = forward ? VIEW_SLIDE_OFFSET : -VIEW_SLIDE_OFFSET;
    // Switching again before the last slide ends: start from the top, not mid-flight.
    for (const running of el.getAnimations()) running.cancel();
    el.animate(
      [
        { opacity: 0.3, transform: `translateX(${from}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: VIEW_SLIDE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }, [ref, view]);
}
