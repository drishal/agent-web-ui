// Phones' gestures, the deciding part: which swipe opens or closes the
// drawer, how far a sheet is dragged to close, and what counts as a long press.
import { describe, expect, it } from "vitest";
import { dragCloses, EDGE_PX, lockAxis, LONG_PRESS_MS, pressIntent, ROW_ACTION_PX, rowRelease, rowSwipe, SHEET_CLOSE_PX, SWIPE_PX, swipeIntent, TOAST_SWIPE_PX, toastSwipe } from "../../src/web/gestures.js";

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

  describe("rowSwipe", () => {
    const o = { actions: 3, width: 300, open: false };
    it("does not follow a vertical drag, so scrolling wins", () => {
      expect(rowSwipe(-3, 40, null, o)).toEqual({ axis: "y", reveal: 0, full: false });
      expect(rowSwipe(-100, 2, "y", o).reveal).toBe(0);
    });
    it("waits for the slop before following", () => {
      expect(rowSwipe(-4, 1, null, o)).toEqual({ axis: null, reveal: 0, full: false });
    });
    it("reveals as far as the finger goes, and only to the left", () => {
      expect(rowSwipe(-100, 3, null, o)).toEqual({ axis: "x", reveal: 100, full: false });
      expect(rowSwipe(50, 0, "x", o).reveal).toBe(0);
    });
    it("is full past most of the row, and never wider than it", () => {
      expect(rowSwipe(-220, 0, "x", o).full).toBe(true);
      expect(rowSwipe(-209, 0, "x", o).full).toBe(false);
      expect(rowSwipe(-900, 0, "x", o).reveal).toBe(300);
    });
    it("starts from the open width when the row is open, and a drag right closes it", () => {
      const open = { ...o, open: true };
      expect(rowSwipe(-10, 0, "x", open).reveal).toBe(3 * ROW_ACTION_PX + 10);
      expect(rowSwipe(3 * ROW_ACTION_PX, 0, "x", open).reveal).toBe(0);
    });
    it("on release: runs the first action when full, stays open past half the actions, else closes", () => {
      expect(rowRelease(rowSwipe(-250, 0, "x", o), 3)).toBe("run");
      expect(rowRelease(rowSwipe(-100, 0, "x", o), 3)).toBe("open");
      expect(rowRelease(rowSwipe(-60, 0, "x", o), 3)).toBe("close");
      expect(rowRelease(rowSwipe(-100, 90, "y", o), 3)).toBe("close");
    });
  });
});
