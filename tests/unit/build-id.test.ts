import { describe, expect, it } from "vitest";
import { buildIdOf } from "../../src/server/build-id.js";

describe("the build id a page compares against", () => {
  it("changes when the served bundle changes, and only then", () => {
    const index = '<script type="module" src="./assets/index-CpnLjIQ6.js"></script>';
    const rebuilt = '<script type="module" src="./assets/index-Btlh-PPY.js"></script>';
    expect(buildIdOf(index)).toBe(buildIdOf(index));
    expect(buildIdOf(index)).not.toBe(buildIdOf(rebuilt));
    // Short enough to show, long enough that two builds do not collide.
    expect(buildIdOf(index)).toMatch(/^[0-9a-f]{10}$/);
  });

  it("is 'dev' when this process serves no bundle at all", () => {
    expect(buildIdOf(null)).toBe("dev");
    expect(buildIdOf(undefined)).toBe("dev");
  });
});
