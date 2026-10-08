// Text for the shown composer's draft from elsewhere on the page: a quoted
// passage, a command's output. The composer appends it and takes the focus.
import { useEffect, useRef } from "react";

const EVENT = "awui:add-to-draft";

export function addToDraft(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: text }));
}

export function useAddToDraft(handler: (text: string) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}

/** A passage as a Markdown quote, one "> " per line. */
export const asQuote = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

/** A prompt's leading-">" lines as quote blocks, the rest as plain text, in order. */
export function quoteParts(text: string): Array<{ quote: boolean; text: string }> {
  const parts: Array<{ quote: boolean; text: string }> = [];
  for (const line of text.split("\n")) {
    const quote = /^>( |$)/.test(line);
    const body = quote ? line.replace(/^> ?/, "") : line;
    const last = parts[parts.length - 1];
    if (last && last.quote === quote) last.text += `\n${body}`;
    else parts.push({ quote, text: body });
  }
  return parts
    .map((p) => (p.quote ? p : { ...p, text: p.text.replace(/^\n+|\n+$/g, "") }))
    .filter((p) => p.quote || p.text !== "");
}
