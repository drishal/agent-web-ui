// Touch gestures for phones: a swipe in from the left edge opens the sessions
// drawer and a swipe left closes it; a sheet follows a downward drag on its
// handle and closes past a threshold; a long press on a message opens its
// actions; a notice card swipes sideways away. The deciding is pure (swipeIntent, dragCloses, pressIntent,
// lockAxis, toastSwipe) so it can be tested; the hooks
// only wire it to touch events.
import { useEffect, useRef, type RefObject } from "react";

/** How close to the left edge a swipe must start to open the drawer, and how far it must travel. */
export const EDGE_PX = 24;
export const SWIPE_PX = 60;
/** How far a sheet is dragged down before it closes. */
export const SHEET_CLOSE_PX = 90;
/** How long a press is held to count as a long press, and how far it may wander. */
export const LONG_PRESS_MS = 480;
export const PRESS_SLOP_PX = 10;

export interface Point {
  x: number;
  y: number;
}

/** What a finished horizontal swipe asks of the drawer: open it (from the edge), close it (leftwards while open), or nothing. */
export function swipeIntent(start: Point, end: Point, drawerOpen: boolean): "open" | "close" | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Mostly vertical is a scroll, not a swipe.
  if (Math.abs(dy) > Math.abs(dx)) return null;
  if (!drawerOpen && start.x <= EDGE_PX && dx >= SWIPE_PX) return "open";
  if (drawerOpen && dx <= -SWIPE_PX) return "close";
  return null;
}

/** Whether a sheet dragged by `dy` pixels (down is positive) should close on release. */
export const dragCloses = (dy: number): boolean => dy >= SHEET_CLOSE_PX;

/** Whether a press held for `ms` and moved to `moved` is still a long press. */
export function pressIntent(ms: number, moved: Point): "long" | "moved" | "short" {
  if (Math.hypot(moved.x, moved.y) > PRESS_SLOP_PX) return "moved";
  return ms >= LONG_PRESS_MS ? "long" : "short";
}

/** How far a finger travels before the gesture picks its direction. */
export const AXIS_SLOP_PX = 8;
/** A notice card dismissed by a sideways swipe at least this far; a shorter one springs back. */
export const TOAST_SWIPE_PX = 64;

export type Axis = "x" | "y";

/** Which way a drag goes once it has moved past the slop: the larger of the two wins and stays (null while undecided). */
export function lockAxis(dx: number, dy: number): Axis | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_SLOP_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** What letting go of a notice card does: a long enough, mostly sideways swipe dismisses it, anything else springs back. */
export function toastSwipe(dx: number, dy: number): "dismiss" | "back" {
  return Math.abs(dx) >= TOAST_SWIPE_PX && Math.abs(dx) > Math.abs(dy) ? "dismiss" : "back";
}

/** Drawer mode: the width at which the sessions panel is a drawer (styles/responsive.css's 819px breakpoint). */
const DRAWER_QUERY = "(max-width: 819px)";

/** Open and close the drawer by swiping, in drawer mode only. */
export function useEdgeSwipe(open: boolean, setOpen: (open: boolean) => void): void {
  const state = useRef({ open, setOpen });
  state.current = { open, setOpen };
  useEffect(() => {
    let start: Point | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t && window.matchMedia(DRAWER_QUERY).matches ? { x: t.clientX, y: t.clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const intent = swipeIntent(start, { x: t.clientX, y: t.clientY }, state.current.open);
      start = null;
      if (intent === "open") state.current.setOpen(true);
      else if (intent === "close") state.current.setOpen(false);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, []);
}

/**
 * A sheet that follows a downward drag on `handle` and closes past the
 * threshold; let go short of it and it springs back. `sheet` is what moves.
 */
export function useSwipeDown(handle: RefObject<HTMLElement | null>, sheet: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = handle.current;
    if (!el) return;
    let startY: number | null = null;
    let dy = 0;
    const move = (y: number) => {
      const s = sheet.current;
      if (s) s.style.transform = y > 0 ? `translateY(${y}px)` : "";
    };
    const onStart = (e: TouchEvent) => {
      startY = e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
      dy = 0;
      if (sheet.current) sheet.current.style.transition = "none";
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      dy = (e.touches[0]?.clientY ?? startY) - startY;
      move(Math.max(0, dy));
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      const s = sheet.current;
      if (s) s.style.transition = "";
      if (dragCloses(dy)) close.current();
      else move(0);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [handle, sheet]);
}

/** Touch screens: where a long press means "actions" (a mouse has hover buttons and a right click). */
export const coarse = (): boolean => window.matchMedia("(pointer: coarse)").matches;

/**
 * A long press on a touch screen, for a message's actions. Presses that start
 * on a link, button, image, or code block keep the browser's own long press
 * (opening links, selecting code).
 */
export function useLongPress(onLongPress: () => void): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
} {
  const press = useRef<{ at: number; start: Point; timer: number; fired: boolean } | null>(null);
  const handler = useRef(onLongPress);
  handler.current = onLongPress;
  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onTouchStart: (e) => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1 || !coarse() || (e.target as HTMLElement).closest("a, button, img, pre, code, textarea, input")) return;
      const start = { x: t.clientX, y: t.clientY };
      const timer = window.setTimeout(() => {
        if (!press.current) return;
        press.current.fired = true;
        window.getSelection()?.removeAllRanges();
        navigator.vibrate?.(12);
        handler.current();
      }, LONG_PRESS_MS);
      press.current = { at: Date.now(), start, timer, fired: false };
    },
    onTouchMove: (e) => {
      const t = e.touches[0];
      if (!press.current || !t) return;
      if (pressIntent(Date.now() - press.current.at, { x: t.clientX - press.current.start.x, y: t.clientY - press.current.start.y }) === "moved") cancel();
    },
    // After a long press, the finger lifting is not a tap: no click lands on the sheet it opened.
    onTouchEnd: (e) => {
      if (press.current?.fired) e.preventDefault();
      cancel();
    },
    // The browser's own long-press menu would open on top of ours.
    onContextMenu: (e) => {
      if (coarse() && press.current?.fired) e.preventDefault();
    },
  };
}
