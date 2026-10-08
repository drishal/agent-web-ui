import { describe, expect, it } from "vitest";
import { asQuote, quoteParts } from "../../src/web/draft-bus.js";

describe("quotes", () => {
  it("quotes every line of a passage", () => {
    expect(asQuote("  first line\n\nsecond line \n")).toBe("> first line\n>\n> second line");
  });
  it("splits a prompt into its quotes and its own words", () => {
    expect(quoteParts("> the answer said\n> this\n\nWhy that?")).toEqual([
      { quote: true, text: "the answer said\nthis" },
      { quote: false, text: "Why that?" },
    ]);
    expect(quoteParts("no quote > here")).toEqual([{ quote: false, text: "no quote > here" }]);
  });
});
