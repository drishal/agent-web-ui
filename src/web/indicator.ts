// The geometry of a sliding indicator: the underline that glides to the active
// tab (session tabs) or the pill that stretches to the selected option (the
// Usage range switch). Pure so the maths is unit-tested; the component
// (SlidingIndicator.tsx) only measures.
export type IndicatorRect = { left: number; width: number };

/** Where the indicator sits: the active item's box against its strip, in the
 * strip's own coordinates, rounded to whole pixels so the line stays sharp. */
export function indicatorRect(boxes: readonly IndicatorRect[], active: number, stripLeft: number): IndicatorRect | null {
  const box = boxes[active];
  if (!box || box.width <= 0) return null;
  const left = Math.round(box.left - stripLeft);
  return { left, width: Math.round(Math.max(0, box.width)) };
}

/** The edge that leads the glide: the indicator stretches toward the new rect
 * (its `left`/`width` transitions have slightly different durations, set in
 * CSS, so the trailing edge lags a beat). Moving right leads with the right
 * edge, moving left with the left one. */
export function leadingEdge(from: IndicatorRect | null, to: IndicatorRect): "left" | "right" {
  if (from === null) return "left";
  const fromMid = from.left + from.width / 2;
  const toMid = to.left + to.width / 2;
  return toMid >= fromMid ? "right" : "left";
}
