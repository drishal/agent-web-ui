import { describe, expect, it } from "vitest";
import { placeCard } from "../../src/web/hover-card.js";

const rect = (left: number, top: number, width = 100, height = 20) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const view = { width: 1000, height: 700 };
const size = { width: 340, height: 200 };

describe("placeCard", () => {
  it("puts a right-side card beside the anchor, a little above its top", () => {
    expect(placeCard(rect(0, 300), size, view, "right")).toEqual({ left: 110, top: 294 });
  });

  it("keeps a right-side card inside the window at the bottom and the top", () => {
    expect(placeCard(rect(0, 650), size, view, "right").top).toBe(700 - 200 - 8);
    expect(placeCard(rect(0, 2), size, view, "right").top).toBe(8);
  });

  it("puts a below card under the anchor, left edges aligned", () => {
    expect(placeCard(rect(120, 100), size, view, "below")).toEqual({ left: 120, top: 126 });
  });

  it("flips a below card above the anchor when there is no room under", () => {
    expect(placeCard(rect(120, 600), size, view, "below")).toEqual({ left: 120, top: 600 - 200 - 6 });
  });

  it("slides a below card left when it would leave the window's right edge", () => {
    expect(placeCard(rect(900, 100), size, view, "below").left).toBe(1000 - 340 - 8);
  });
});
