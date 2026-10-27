// The draft's size estimate and its thresholds (token-estimate.ts).
import { describe, expect, it } from "vitest";
import type { ContextUsage } from "../../src/shared/protocol.js";
import { SHOW_FROM_TOKENS, TOKENS_PER_IMAGE, draftRow, draftSize, draftTokens, draftWarning, estimateTokens, formatDraftTokens } from "../../src/web/token-estimate.js";

const ctx = (tokens: number | null, window = 100_000, percent: number | null = tokens === null ? null : (tokens / window) * 100): ContextUsage => ({ tokens, window, percent });

describe("estimateTokens", () => {
  it("counts prose at about four characters a token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("word ".repeat(400))).toBe(500);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("counts symbols and non-ASCII denser, and CJK a token a character", () => {
    const prose = estimateTokens("a".repeat(400));
    expect(estimateTokens("{};()".repeat(80))).toBeGreaterThan(prose);
    expect(estimateTokens("é".repeat(400))).toBeGreaterThan(prose);
    expect(estimateTokens("日本語のテキスト")).toBe(8);
    expect(estimateTokens("한국어")).toBe(3);
  });

  it("handles a huge paste in one pass", () => {
    expect(estimateTokens("x".repeat(4_000_000))).toBe(1_000_000);
  });

  it("adds a flat amount per image", () => {
    expect(draftTokens("abcd", 2)).toBe(1 + 2 * TOKENS_PER_IMAGE);
  });
});

describe("formatDraftTokens", () => {
  it("rounds to what a guess can claim", () => {
    expect(formatDraftTokens(7)).toBe("7");
    expect(formatDraftTokens(204)).toBe("200");
    expect(formatDraftTokens(999)).toBe("1000");
    expect(formatDraftTokens(1000)).toBe("1k");
    expect(formatDraftTokens(1234)).toBe("1.2k");
    expect(formatDraftTokens(12_345)).toBe("12k");
    expect(formatDraftTokens(1_250_000)).toBe("1.3M");
  });
});

describe("draftSize", () => {
  const long = "word ".repeat(400);

  it("stays hidden for a small draft, and shows from the threshold or any image", () => {
    expect(draftSize("", 0, ctx(1000))).toBeNull();
    expect(draftSize("hello there", 0, ctx(1000))).toBeNull();
    expect(draftSize("a".repeat(SHOW_FROM_TOKENS * 4 - 4), 0, null)).toBeNull();
    expect(draftSize("a".repeat(SHOW_FROM_TOKENS * 4), 0, null)?.tokens).toBe(SHOW_FROM_TOKENS);
    expect(draftSize("", 1, null)?.tokens).toBe(TOKENS_PER_IMAGE);
    expect(draftSize("", 1, null)?.label).toBe("~1.5k tokens");
  });

  it("works out the context's share before and after", () => {
    const size = draftSize(long, 0, ctx(17_000));
    expect(size).toMatchObject({ tokens: 500, label: "~500 tokens", near: false });
    expect(size?.from).toBeCloseTo(17, 5);
    expect(size?.to).toBeCloseTo(17.5, 5);
  });

  it("works back from the percentage when the harness gives no token count", () => {
    const size = draftSize(long, 0, ctx(null, 10_000, 40));
    expect(size?.from).toBeCloseTo(40, 5);
    expect(size?.to).toBeCloseTo(45, 5);
  });

  it("says only the figure while the window or its use is unknown", () => {
    expect(draftSize(long, 0, null)).toEqual({ tokens: 500, label: "~500 tokens", from: null, to: null, near: false });
    expect(draftSize(long, 0, ctx(null))).toMatchObject({ from: null, to: null, near: false });
    expect(draftSize(long, 0, ctx(5, 0, 0))).toMatchObject({ from: null, to: null, near: false });
  });

  it("is near the limit only when sending would pass 90% of the window", () => {
    expect(draftSize(long, 0, ctx(89_000))?.near).toBe(false); // 89.5%
    expect(draftSize(long, 0, ctx(89_600))?.near).toBe(true); // 90.1%
    expect(draftSize(long, 0, ctx(95_000))?.near).toBe(true);
    // Images count: 1,500 tokens on a 10,000 window from 80% is 95%.
    expect(draftSize("", 1, ctx(8000, 10_000))?.near).toBe(true);
  });
});

describe("the panel's wording", () => {
  it("shows the move through the context", () => {
    const size = draftSize("word ".repeat(1000), 0, ctx(17_000, 100_000)) as NonNullable<ReturnType<typeof draftSize>>;
    expect(draftRow(size)).toBe("This message ≈ 1.3k tokens → context 17% → 18%");
    expect(draftWarning(size, true)).toBeNull();
  });

  it("drops the percentages when the window is unknown", () => {
    const size = draftSize("word ".repeat(400), 0, null) as NonNullable<ReturnType<typeof draftSize>>;
    expect(draftRow(size)).toBe("This message ≈ 500 tokens");
  });

  it("suggests Compact only where the harness has it", () => {
    const size = draftSize("word ".repeat(400), 0, ctx(95_000)) as NonNullable<ReturnType<typeof draftSize>>;
    expect(draftWarning(size, true)).toBe("Close to the context limit — consider Compact");
    expect(draftWarning(size, false)).toBe("Close to the context limit");
  });
});
