// Scroll a turn to the top of its `.conversation` scroller — and nothing else.
//
// The obvious `node.scrollIntoView({ block: "start" })` also scrolls every
// scrollable ancestor of the turn. `.conversation` is the intended scroller, but
// the `.main` column above it is `overflow: visible`, so it overflows too: to make
// the turn reach `block: "start"`, the browser scrolls `.main` up by the header's
// height inside the fixed-height `.app` grid (`overflow: hidden`), sliding the whole
// column — header, composer, status bar — up and leaving a blank band at the bottom
// with a stray page scrollbar. Computing `scrollTop` for the conversation
// coordinates scrolls only that scroller and can never touch an ancestor.

/** Scroll `turnEl` to the top edge of the `scroller` it lives in. */
export function scrollTurnIntoView(scroller: HTMLElement, turnEl: HTMLElement, behavior: ScrollBehavior = "smooth"): void {
  const top = turnEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top, behavior });
}
