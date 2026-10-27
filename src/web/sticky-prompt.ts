// The sticky prompt bar's decisions (components/StickyPrompt.tsx draws it): which turn's prompt
// has scrolled out above the view while its answer is still on screen, and the words for it.
// Pure, so the rule is tested without a browser; the component only measures and calls this.

/** The bar's height in px (`.sticky-prompt` in conversation.css): a turn ends for the bar this far before the view's top, as the next prompt would slide under it. */
export const STICKY_BAR_PX = 30;

/** Where one turn sits, in px from the top of the conversation's view (negative: above it). */
export interface TurnBox {
  /** The prompt bubble's bottom edge. */
  promptBottom: number;
  /** The turn's bottom edge, which is where the next turn's prompt begins. */
  bottom: number;
}

/**
 * The index of the turn whose prompt the bar shows, or -1 for none: the last turn whose prompt is
 * wholly above the view, if its end has not yet reached the bar. `box` measures one turn, or says
 * null for one not drawn yet (a long chat draws its oldest turns last): those come first, so they
 * count as above the view. Prompts only move up as the index grows, so this is a binary search and
 * a scroll measures a handful of turns, not all of them.
 */
export function stickyTurn(count: number, box: (index: number) => TurnBox | null, clearance = STICKY_BAR_PX): number {
  const scrolledPast = (index: number) => {
    const at = box(index);
    return at === null || at.promptBottom <= 0;
  };
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (scrolledPast(mid)) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (found < 0) return -1;
  const at = box(found);
  return at !== null && at.bottom > clearance ? found : -1;
}

/** A prompt as one line for the bar: whitespace folded, bounded (the bar ellipsises what does not fit). */
export function stickyLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return line || "(no text)";
}

/** The bar's accessible name: it goes back to the prompt. */
export function stickyLabel(number: number, line: string): string {
  return `Back to prompt #${number}: ${line}`;
}
