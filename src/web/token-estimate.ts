// How big the draft is, in tokens, while it is typed (the composer's figure beside the
// context ring). A rough guess made in the browser: a tokenizer is model-specific and
// far too heavy to ship, and the point is only "a small note" against "most of the window".
// Pure, so the rule and the thresholds are unit-tested; the ring only draws the result.
import type { ContextUsage } from "../shared/protocol.js";

/** Below this the figure stays hidden: a short sentence is not worth a number (images always show it). */
export const SHOW_FROM_TOKENS = 200;

/** Past this share of the window a send is "close to the limit": the figure turns to the warning colour. */
export const NEAR_LIMIT_PERCENT = 90;

/**
 * What one attached image costs, a flat guess: providers price an image by its size
 * (roughly 1,000 to 1,600 tokens for a typical screenshot after resizing), and awui
 * does not know which model will see it.
 */
export const TOKENS_PER_IMAGE = 1500;

// Hiragana, katakana, CJK ideographs and Hangul: about a token a character, against about a quarter for English.
const isWide = (code: number) => (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff);

/**
 * Estimated tokens in a text: a quarter token per letter, digit, or space (the usual
 * "4 characters a token"), half per ASCII symbol (code and markup split into many short
 * tokens) or other non-ASCII character (accents, emoji), a whole one per CJK character.
 * One linear pass with no allocation, since the draft can be a multi-megabyte paste.
 */
export function estimateTokens(text: string): number {
  let quarters = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 32 || code === 10 || code === 13 || code === 9;
      quarters += word ? 1 : 2;
    } else quarters += isWide(code) ? 4 : 2;
  }
  return Math.ceil(quarters / 4);
}

/** The draft's tokens: its text and its images. */
export function draftTokens(text: string, images: number): number {
  return estimateTokens(text) + images * TOKENS_PER_IMAGE;
}

/** "500", "1.2k", "12k", "1.2M": the figure as the label says it (never more precision than the guess has). */
export function formatDraftTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n >= 100 ? Math.round(n / 10) * 10 : n);
}

export interface DraftSize {
  tokens: number;
  /** The label: "~1.2k tokens". */
  label: string;
  /** The context's share before and after sending this, in percent; null while the window or its use is unknown. */
  from: number | null;
  to: number | null;
  /** Sending would leave the context past NEAR_LIMIT_PERCENT of the window. */
  near: boolean;
}

/**
 * The draft's size against the context, or null while it is too small to mention.
 * The used tokens are the harness's count when it gives one, else worked back from its percentage.
 */
export function draftSize(text: string, images: number, context: ContextUsage | null): DraftSize | null {
  const tokens = draftTokens(text, images);
  if (images === 0 && tokens < SHOW_FROM_TOKENS) return null;
  const label = `~${formatDraftTokens(tokens)} tokens`;
  const used = context && context.window > 0 ? (context.tokens ?? (context.percent !== null ? (context.percent / 100) * context.window : null)) : null;
  if (!context || used === null) return { tokens, label, from: null, to: null, near: false };
  const from = (used / context.window) * 100;
  const to = ((used + tokens) / context.window) * 100;
  return { tokens, label, from, to, near: to > NEAR_LIMIT_PERCENT };
}

/** The panel's row: "This message ≈ 1.2k tokens → context 17% → 19%" (no percentages while the window is unknown). */
export function draftRow(size: DraftSize): string {
  const pct = (n: number) => (n > 0 && n < 1 ? "<1%" : `${Math.round(n)}%`);
  return `This message ≈ ${formatDraftTokens(size.tokens)} tokens` + (size.from !== null && size.to !== null ? ` → context ${pct(size.from)} → ${pct(size.to)}` : "");
}

/** The warning under it when sending nears the limit; it suggests Compact only where the harness can. */
export function draftWarning(size: DraftSize, canCompact: boolean): string | null {
  if (!size.near) return null;
  return canCompact ? "Close to the context limit — consider Compact" : "Close to the context limit";
}
