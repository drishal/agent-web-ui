// Touch gestures for phones: a swipe in from the left edge opens the sessions
// drawer and a swipe left closes it; a sheet follows a downward drag on its
// handle and closes past a threshold; a long press on a message opens its
// actions; a notice card swipes sideways away; a session row swipes left to
// show its actions. The deciding is pure (swipeIntent, dragCloses, pressIntent,
// lockAxis, toastSwipe, rowSwipe, rowRelease) so it can be tested; the hooks
// only wire it to touch events.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

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
/** The width of one revealed row action, and how much of the row a swipe must cross to run the first action outright. */
export const ROW_ACTION_PX = 64;
export const ROW_FULL_FRACTION = 0.7;

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

export interface RowSwipe {
  /** The locked direction; a row only follows "x", so vertical scrolling wins. */
  axis: Axis | null;
  /** How many pixels of actions are shown from the right edge (0 when not following). */
  reveal: number;
  /** Past the point where letting go runs the first action. */
  full: boolean;
}

/**
 * A session row dragged by (dx, dy) from where the finger went down. `locked` is the axis already decided
 * (null before); `open` is a row that already shows its actions, which a drag right closes. `actions` is how
 * many actions it has, `width` the row's.
 */
export function rowSwipe(dx: number, dy: number, locked: Axis | null, o: { actions: number; width: number; open: boolean }): RowSwipe {
  const axis = locked ?? lockAxis(dx, dy);
  if (axis !== "x") return { axis, reveal: 0, full: false };
  const base = o.open ? o.actions * ROW_ACTION_PX : 0;
  const reveal = Math.min(Math.max(0, base - dx), o.width);
  return { axis, reveal, full: reveal >= o.width * ROW_FULL_FRACTION };
}

/** What letting go of a row does: run the first action (full swipe), stay open (past half the actions), or close (also for a cancelled touch, which never calls this). */
export function rowRelease(swipe: RowSwipe, actions: number): "run" | "open" | "close" {
  if (swipe.axis !== "x") return "close";
  if (swipe.full) return "run";
  return swipe.reveal >= (actions * ROW_ACTION_PX) / 2 ? "open" : "close";
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
      // A session row swipes left for its own actions; that is not the drawer closing.
      if ((e.target as Element | null)?.closest?.("[data-row-swipe]")) {
        start = null;
        return;
      }
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

/**
 * A session row that slides left under a finger to show its actions (touch only; a mouse has the ⋯ button).
 * Spread `handlers` on the row. `reveal` is how many pixels of actions show; `run` is called on a full swipe
 * (the first action). A drag that is mostly vertical is left to the browser's scroll (`touch-action: pan-y`).
 */
export function useRowSwipe(
  enabled: boolean,
  actions: number,
  run: () => void,
): {
  reveal: number;
  dragging: boolean;
  close: () => void;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onClickCapture: (e: React.MouseEvent) => void;
  };
} {
  const [view, setView] = useState({ reveal: 0, dragging: false });
  const drag = useRef<{ x: number; y: number; axis: Axis | null; width: number; open: boolean; last: RowSwipe | null } | null>(null);
  // The click that follows a swipe (or that lands on an open row) must not open the session.
  const swallow = useRef(false);
  const latest = useRef({ run, actions, reveal: view.reveal });
  latest.current = { run, actions, reveal: view.reveal };
  const close = useCallback(() => setView({ reveal: 0, dragging: false }), []);
  // Any press elsewhere closes an open row.
  useEffect(() => {
    if (view.reveal === 0 || view.dragging) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".row-swipe-actions")) close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [view.reveal, view.dragging, close]);
  return {
    ...view,
    close,
    handlers: {
      onPointerDown: (e) => {
        if (!enabled || e.pointerType !== "touch" || !e.isPrimary) return;
        swallow.current = false;
        drag.current = { x: e.clientX, y: e.clientY, axis: null, width: e.currentTarget.clientWidth, open: latest.current.reveal > 0, last: null };
      },
      onPointerMove: (e) => {
        const d = drag.current;
        if (!d) return;
        const sw = rowSwipe(e.clientX - d.x, e.clientY - d.y, d.axis, { actions: latest.current.actions, width: d.width, open: d.open });
        d.axis = sw.axis;
        if (sw.axis !== "x") return;
        d.last = sw;
        swallow.current = true;
        setView({ reveal: sw.reveal, dragging: true });
      },
      onPointerUp: () => {
        const d = drag.current;
        drag.current = null;
        if (!d?.last) return;
        const outcome = rowRelease(d.last, latest.current.actions);
        if (outcome === "run") {
          setView({ reveal: 0, dragging: false });
          latest.current.run();
        } else setView({ reveal: outcome === "open" ? latest.current.actions * ROW_ACTION_PX : 0, dragging: false });
      },
      // The browser took the touch for a scroll (or it was interrupted): nothing is kept half-way.
      onPointerCancel: () => {
        const d = drag.current;
        drag.current = null;
        if (d?.last) setView({ reveal: 0, dragging: false });
      },
      onClickCapture: (e) => {
        if ((e.target as Element).closest(".row-swipe-actions")) return;
        if (swallow.current) {
          swallow.current = false;
          e.preventDefault();
          e.stopPropagation();
        } else if (latest.current.reveal > 0) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      },
    },
  };
}
