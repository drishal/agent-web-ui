// An absolutely positioned indicator that glides to the active child of a
// strip (a tab underline, a segmented pill). It measures the children's boxes
// in a layout effect and sets `left`/`width` plus `--lead`, so the CSS can
// give the edge toward the target the shorter transition and let the trailing
// edge lag a beat. Decorative only: the tabs themselves keep aria-selected.
import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { indicatorRect, leadingEdge, type IndicatorRect } from "../indicator.js";

export function SlidingIndicator<T extends Element = Element>({
  target,
  active,
  of,
  enabled = true,
  className,
  style,
}: {
  /** The strip whose boxes are measured (the tab list, the segmented row). */
  target: RefObject<T | null>;
  /** Index of the active child. */
  active: number;
  /** A CSS selector for the children to measure, against the strip. */
  of: string;
  /** False while a drag is going: the old position would lag the pointer. */
  enabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const prev = useRef<IndicatorRect | null>(null);

  useLayoutEffect(() => {
    const el = bar.current;
    const strip = target.current;
    const hide = () => {
      el?.setAttribute("hidden", "");
      prev.current = null;
    };
    if (!el || !strip || !enabled || active < 0) return hide();
    const boxes = Array.from(strip.querySelectorAll<HTMLElement>(of), (c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left, width: r.width } satisfies IndicatorRect;
    });
    const rect = indicatorRect(boxes, active, strip.getBoundingClientRect().left);
    if (!rect) return hide();
    el.removeAttribute("hidden");
    el.style.setProperty("--lead", leadingEdge(prev.current, rect));
    el.style.left = `${rect.left}px`;
    el.style.width = `${rect.width}px`;
    prev.current = rect;
  });

  // Measure again when the strip's size changes (fonts, density, the sidebar).
  useLayoutEffect(() => {
    const strip = target.current;
    if (!strip || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      // Writing styles inside the observer's own frame races it; defer.
      window.clearTimeout(t);
      t = setTimeout(() => {
        const el = bar.current;
        if (!el || el.hasAttribute("hidden")) return;
        const boxes = Array.from(strip.querySelectorAll<HTMLElement>(of), (c) => {
          const r = c.getBoundingClientRect();
          return { left: r.left, width: r.width } satisfies IndicatorRect;
        });
        const rect = indicatorRect(boxes, active, strip.getBoundingClientRect().left);
        if (!rect) return;
        el.style.setProperty("--lead", leadingEdge(prev.current, rect));
        el.style.left = `${rect.left}px`;
        el.style.width = `${rect.width}px`;
        prev.current = rect;
      }, 0);
    });
    ro.observe(strip);
    return () => {
      window.clearTimeout(t);
      ro.disconnect();
    };
  }, [target, of, active]);

  return <div ref={bar} className={`sliding-indicator ${className ?? ""}`} style={style} hidden aria-hidden="true" />;
}
