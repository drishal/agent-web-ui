// A measured open/close for a tool call's row: when it opens, the row's surface unfurls
// into the card it becomes. Unlike Collapse's grid-grow (which animates the body's height
// under a fixed head), this drives the *container's* height from the head's height to the
// open height, so the head reads as the card's header unrolling, and the body fades in
// behind the growing surface. Height is set inline and transitioned by CSS (motion.css's
// --ease-spring); when the transition ends it clears back to auto, so an output that keeps
// streaming resizes the card without a fight. Text never distorts (no transform).
//
// Only a lone call uses it (a read/edit/command row as its own card); a run of calls keeps
// its process-card header. Reduced motion or a failed measure falls back to Collapse's grow.
import { useLayoutEffect, useRef, useState } from "react";

/** The spring the surface grows with, and when a close unmounts the body. */
const UNFURL_MS = 300;

/**
 * useUnfurl returns the container's `style.height` while the row morphs, `undefined` once
 * settled, and whether it is mid-morph. `containerRef` is the row's line element whose
 * height transitions; `headRef` measures the closed height. The body is Collapse's, mounted
 * inside it, so the open height is read on the next frame from the container's scrollHeight
 * (the content is already there by then); nothing has to exist at the moment open flips.
 */
export function useUnfurl(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  headRef: React.RefObject<HTMLElement | null>,
): { height?: number; morphing: boolean } {
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [morphing, setMorphing] = useState(false);
  const prevOpen = useRef(open);
  // Keep the body mounted through the close's shrink, so the surface has content to shrink around.
  const [holdBody, setHoldBody] = useState(open);
  useLayoutEffect(() => {
    if (open) setHoldBody(true);
  }, [open]);

  useLayoutEffect(() => {
    if (open === prevOpen.current) return;
    prevOpen.current = open;
    const container = containerRef.current;
    const head = headRef.current;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!container || !head || reduce) {
      setHeight(undefined);
      if (!open) setHoldBody(false);
      return;
    }
    const headH = head.getBoundingClientRect().height;
    setMorphing(true);
    if (open) {
      // Pin the container to the head's height now, so the body's own grow (Collapse) does not
      // carry it; then next frame, with the body laid out, grow to the full content height.
      setHeight(headH);
      const raf = requestAnimationFrame(() => {
        setHeight(headH + (container.scrollHeight - container.clientHeight));
      });
      const done = window.setTimeout(() => {
        setHeight(undefined);
        setMorphing(false);
      }, UNFURL_MS + 40);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(done);
      };
    }
    // Closing: from the full height back to the head; the body may already hold content.
    setHeight(container.getBoundingClientRect().height);
    const raf = requestAnimationFrame(() => setHeight(headH));
    const done = window.setTimeout(() => {
      setHeight(undefined);
      setMorphing(false);
      setHoldBody(false);
    }, UNFURL_MS + 40);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [open, containerRef, headRef]);

  return { height, morphing: morphing || (holdBody && !open) };
}
