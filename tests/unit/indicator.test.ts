// The geometry of a sliding indicator: indicatorRect and leadingEdge (indicator.ts).
import { describe, expect, it } from "vitest";
import { indicatorRect, leadingEdge, type IndicatorRect } from "../../src/web/indicator.js";

describe("indicatorRect", () => {
  const boxes: IndicatorRect[] = [
    { left: 100.4, width: 80.2 },
    { left: 181.6, width: 60.9 },
    { left: 243.1, width: 0 },
  ];

  it("takes the active box, in the strip's own coordinates, rounded to pixels", () => {
    expect(indicatorRect(boxes, 0, 100)).toEqual({ left: 0, width: 80 });
    expect(indicatorRect(boxes, 1, 100)).toEqual({ left: 82, width: 61 });
  });

  it("gives nothing for an out-of-range index or a widthless box", () => {
    expect(indicatorRect(boxes, 5, 100)).toBeNull();
    expect(indicatorRect(boxes, 2, 100)).toBeNull();
    expect(indicatorRect([], 0, 100)).toBeNull();
  });
  it("keeps a negative left: a partially scrolled tab keeps its underline", () => {
    // The indicator sits inside the strip's scrolling box, so it moves with the tab.
    expect(indicatorRect([{ left: 90, width: 50 }], 0, 100)).toEqual({ left: -10, width: 50 });
  });
});

describe("leadingEdge", () => {
  const at = (left: number, width = 80): IndicatorRect => ({ left, width });

  it("leads with the right edge when gliding right, the left when gliding left", () => {
    expect(leadingEdge(at(0), at(100))).toBe("right");
    expect(leadingEdge(at(100), at(0))).toBe("left");
  });

  it("leads right when nothing came before (a first draw)", () => {
    expect(leadingEdge(null, at(100))).toBe("left");
  });

  it("stays put (right) when the centre does not move", () => {
    expect(leadingEdge(at(100), at(100))).toBe("right");
  });
});
