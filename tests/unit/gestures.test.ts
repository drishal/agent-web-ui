// Phones' gestures, the deciding part: which swipe opens or closes the
// drawer, how far a sheet is dragged to close, and what counts as a long press.
import { describe, expect, it } from "vitest";
import { dragCloses, EDGE_PX, lockAxis, LONG_PRESS_MS, pressIntent, SHEET_CLOSE_PX, SWIPE_PX, swipeIntent, TOAST_SWIPE_PX, toastSwipe } from "../../src/web/gestures.js";

describe("gestures", () => {
  it("opens the drawer only from the left edge, and closes it with a swipe left", () => {
    expect(swipeIntent({ x: 8, y: 300 }, { x: 8 + SWIPE_PX, y: 310 }, false)).toBe("open");
    expect(swipeIntent({ x: EDGE_PX + 40, y: 300 }, { x: 300, y: 300 }, false)).toBeNull();
    expect(swipeIntent({ x: 8, y: 300 }, { x: 40, y: 300 }, false)).toBeNull();
    expect(swipeIntent({ x: 300, y: 300 }, { x: 300 - SWIPE_PX, y: 300 }, true)).toBe("close");
    // Mostly vertical: a scroll, whatever the direction.
    expect(swipeIntent({ x: 8, y: 100 }, { x: 90, y: 400 }, false)).toBeNull();
  });

  it("closes a sheet dragged far enough down, and springs back otherwise", () => {
    expect(dragCloses(SHEET_CLOSE_PX)).toBe(true);
    expect(dragCloses(SHEET_CLOSE_PX - 1)).toBe(false);
    expect(dragCloses(-200)).toBe(false);
  });

  it("counts a held press that stays put as long, and one that wanders as a scroll", () => {
    expect(pressIntent(LONG_PRESS_MS, { x: 2, y: 3 })).toBe("long");
    expect(pressIntent(LONG_PRESS_MS - 100, { x: 0, y: 0 })).toBe("short");
    expect(pressIntent(LONG_PRESS_MS, { x: 0, y: 30 })).toBe("moved");
  });

  it("locks a drag to the larger axis after the slop", () => {
    expect(lockAxis(3, 4)).toBeNull();
    expect(lockAxis(-20, 5)).toBe("x");
    expect(lockAxis(5, 30)).toBe("y");
  });

  it("dismisses a notice card on a long enough sideways swipe and springs back otherwise", () => {
    expect(toastSwipe(-TOAST_SWIPE_PX, 4)).toBe("dismiss");
    expect(toastSwipe(TOAST_SWIPE_PX + 10, 0)).toBe("dismiss");
    expect(toastSwipe(-(TOAST_SWIPE_PX - 1), 0)).toBe("back");
    expect(toastSwipe(-TOAST_SWIPE_PX, TOAST_SWIPE_PX * 2)).toBe("back");
  });
});
