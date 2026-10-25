import { describe, expect, it } from "vitest";
import { viewSlideDirection } from "../../src/web/view-slide.js";

describe("the sidebar's view slide", () => {
  it("goes forward into a folder, and from one folder to another", () => {
    expect(viewSlideDirection("all", "w1")).toBe("forward");
    expect(viewSlideDirection("w1", "w2")).toBe("forward");
  });

  it("goes back only when leaving a folder for all projects", () => {
    expect(viewSlideDirection("w1", "all")).toBe("back");
  });
});
