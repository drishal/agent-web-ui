import { describe, expect, it } from "vitest";
import { choicesOf, splitStep } from "../../src/web/questions.js";

describe("question options", () => {
  it("splits a question's step off its text", () => {
    expect(splitStep("Move both? (1/2)")).toEqual({ text: "Move both?", step: "1 of 2" });
    expect(splitStep("Plain")).toEqual({ text: "Plain", step: null });
  });

  it("reads Recommended and Other off the labels, and keeps each option's description", () => {
    const choices = choicesOf({ id: "r", kind: "select", title: "", options: ["Both (Recommended)", "Other (type your own)"], optionDetails: ["Shared", ""], createdAt: 0 });
    expect(choices).toEqual([
      { value: "Both (Recommended)", label: "Both", recommended: true, other: false, detail: "Shared" },
      { value: "Other (type your own)", label: "Other (type your own)", recommended: false, other: true },
    ]);
  });
});
