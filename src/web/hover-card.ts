// What every hover card shares (the sidebar's session card, a file link's
// preview): a short rest of the mouse (or keyboard focus) before it shows, a
// scroll or a press that takes it away again, and a place that keeps it inside
// the window. The placement is pure so it can be tested without a browser.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type CardSide = "right" | "below";

export interface CardPlace {
  left: number;
  top: number;
}

const EDGE = 8;

/**
 * Where a card of `size` goes against `anchor` in a `view`-sized window:
 * "right" sits beside the anchor (its top a little above the anchor's),
 * "below" sits under it, or above when there is no room under. Always kept
 * EDGE pixels inside the window.
 */
export function placeCard(anchor: DOMRect, size: { width: number; height: number }, view: { width: number; height: number }, side: CardSide): CardPlace {
  const clamp = (v: number, max: number) => Math.max(EDGE, Math.min(v, max));
  if (side === "right") return { left: anchor.right + 10, top: clamp(anchor.top - 6, view.height - size.height - EDGE) };
  const under = anchor.bottom + 6;
  const top = under + size.height <= view.height - EDGE ? under : anchor.top - size.height - 6;
  return { left: clamp(anchor.left, view.width - size.width - EDGE), top: Math.max(EDGE, top) };
}

/**
 * The anchor's rect once the pointer (or focus) has rested for `delay` ms,
 * else null. `show(element)` starts the wait; `hide()` ends it. A scroll
 * anywhere hides the card, because it would be left behind.
 */
export function useHoverCard(delay: number) {
  const timer = useRef(0);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  }, []);
  const show = useCallback(
    (el: Element) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), delay);
    },
    [delay],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", hide, { capture: true });
  }, [anchor, hide]);
  return { anchor, show, hide };
}

/** A card's place, measured after it draws (its size is not known before) and again when `deps` change. */
export function useCardPlace(ref: RefObject<HTMLElement | null>, anchor: DOMRect, side: CardSide, deps: readonly unknown[]): CardPlace {
  const [place, setPlace] = useState<CardPlace>(() => placeCard(anchor, { width: 0, height: 0 }, { width: window.innerWidth, height: window.innerHeight }, side));
  useLayoutEffect(() => {
    const el = ref.current;
    setPlace(placeCard(anchor, { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 }, { width: window.innerWidth, height: window.innerHeight }, side));
  }, [anchor, side, ...deps]);
  return place;
}
