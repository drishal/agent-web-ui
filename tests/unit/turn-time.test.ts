import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { buildTurns } from "../../src/web/turns.js";
import { formatSpan, formatWhen, timingLabel, turnTiming } from "../../src/web/turn-time.js";

// Dates are built in the local zone and the locale is fixed, so the assertions hold in any time zone.
const at = (y: number, month: number, d: number, h: number, min: number) => new Date(y, month - 1, d, h, min).getTime();
// A Tuesday afternoon.
const NOW = at(2026, 10, 27, 16, 0);

describe("formatWhen", () => {
  it("shows only the time for today", () => {
    expect(formatWhen(at(2026, 10, 27, 15, 41), NOW, "en-US")).toBe("3:41 pm");
    expect(formatWhen(at(2026, 10, 27, 0, 5), NOW, "en-US")).toBe("12:05 am");
  });

  it("names the weekday for yesterday and the rest of the week", () => {
    expect(formatWhen(at(2026, 10, 26, 15, 41), NOW, "en-US")).toBe("Mon 3:41 pm");
    expect(formatWhen(at(2026, 10, 21, 9, 3), NOW, "en-US")).toBe("Wed 9:03 am");
  });

  it("gives the date from a week back, and the year when it is not this one", () => {
    expect(formatWhen(at(2026, 10, 20, 15, 41), NOW, "en-US")).toBe("Oct 20, 3:41 pm");
    expect(formatWhen(at(2026, 10, 12, 15, 41), NOW, "en-US")).toBe("Oct 12, 3:41 pm");
    expect(formatWhen(at(2025, 10, 12, 15, 41), NOW, "en-US")).toBe("Oct 12, 2025, 3:41 pm");
  });

  it("counts calendar days, not 24-hour spans: late last night is yesterday", () => {
    expect(formatWhen(at(2026, 10, 26, 23, 59), at(2026, 10, 27, 0, 1), "en-US")).toBe("Mon 11:59 pm");
  });

  it("does not call a time ahead of now a weekday", () => {
    expect(formatWhen(at(2026, 10, 28, 9, 0), NOW, "en-US")).toBe("Oct 28, 9:00 am");
  });

  it("follows a 24-hour locale", () => {
    expect(formatWhen(at(2026, 10, 27, 15, 41), NOW, "de-DE")).toBe("15:41");
  });
});

describe("formatSpan", () => {
  it("keeps tenths under ten seconds and falls back on the fold's wording after", () => {
    expect(formatSpan(1200)).toBe("1.2s");
    expect(formatSpan(400)).toBe("0.4s");
    expect(formatSpan(24_000)).toBe("24s");
    expect(formatSpan(125_000)).toBe("2m 5s");
  });
});

describe("a turn's timing", () => {
  const user = (t?: number): ChatItem => ({ kind: "user", id: "u", text: "go", ...(t !== undefined ? { at: t } : {}) });
  const assistant = (id: string, text: string, t?: number, endedAt?: number): ChatItem => ({
    kind: "assistant",
    id,
    text,
    thinking: "",
    streaming: false,
    ...(t !== undefined ? { at: t } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  });
  const turnOf = (...items: ChatItem[]) => {
    const turn = buildTurns(items, "idle")[0];
    if (!turn) throw new Error("no turn");
    return turn;
  };

  it("measures the turn and the wait for the first words", () => {
    const timing = turnTiming(turnOf(user(1000), assistant("a", "done", 2200, 25_000)));
    expect(timing).toEqual({ durationMs: 24_000, firstTokenMs: 1200 });
    expect(timingLabel(timing)).toBe("24s · first token 1.2s");
  });

  it("takes the first token from the earliest assistant item, a thought included", () => {
    const thought: ChatItem = { kind: "assistant", id: "t", text: "", thinking: "hmm", streaming: false, at: 1500 };
    const timing = turnTiming(turnOf(user(1000), thought, assistant("a", "done", 9000, 12_000)));
    expect(timing.firstTokenMs).toBe(500);
  });

  it("gives a rate only when the turn's own token count and generation time are given", () => {
    const turn = turnOf(user(1000), assistant("a", "done", 2200, 25_000));
    const timing = turnTiming(turn, { outputTokens: 1250, generationMs: 24_000 });
    expect(timing.tokensPerSecond).toBeCloseTo(52.08, 1);
    expect(timingLabel(timing)).toBe("24s · 52 tok/s · first token 1.2s");
    expect(turnTiming(turn, { outputTokens: 0, generationMs: 24_000 }).tokensPerSecond).toBeUndefined();
    expect(turnTiming(turn, { outputTokens: 100, generationMs: 0 }).tokensPerSecond).toBeUndefined();
    expect(turnTiming(turn).tokensPerSecond).toBeUndefined();
  });

  it("leaves out what it cannot know", () => {
    // No time on the prompt: no first token, and nothing to start the duration from but the answer's own.
    expect(turnTiming(turnOf(user(), assistant("a", "done")))).toEqual({});
    expect(timingLabel(turnTiming(turnOf(user(), assistant("a", "done"))))).toBeNull();
    // A prompt time and an answer with none: nothing ended later, so no duration and no first token.
    expect(turnTiming(turnOf(user(1000), assistant("a", "done")))).toEqual({});
    // Times only on the answer: the duration runs from its start to its end, and there is no first token.
    expect(turnTiming(turnOf(user(), assistant("a", "done", 3000, 8000)))).toEqual({ durationMs: 5000 });
  });

  it("ignores a first item that claims to come before the prompt", () => {
    expect(turnTiming(turnOf(user(5000), assistant("a", "done", 4000, 9000))).firstTokenMs).toBeUndefined();
  });

  it("shows nothing for a zero-length turn", () => {
    expect(turnTiming(turnOf(user(1000), assistant("a", "done", 1000, 1000))).durationMs).toBeUndefined();
  });
});
