// Prompt links (T3 Code's): a URL whose `?prompt=` opens a new chat with that
// text in the composer, to read and send yourself; a link never sends. Text
// that would hide from a reader (zero-width characters, bidirectional
// controls, Unicode tag characters) is taken out, and the composer says so.

/** The longest prompt a link may carry; a URL is a poor place for more. */
export const MAX_LINKED_PROMPT = 8000;

// Zero-width and joiner characters, bidi embeddings, overrides, and isolates, the BOM, and tag characters.
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/g;

/** The text a link carries, cleaned, and how many hidden characters were taken out. */
export function linkedPrompt(raw: string): { text: string; hidden: number } {
  const cut = raw.slice(0, MAX_LINKED_PROMPT);
  let hidden = 0;
  const text = cut.replace(HIDDEN, () => {
    hidden++;
    return "";
  });
  return { text: text.replace(/\r\n?/g, "\n"), hidden };
}

/** A link that opens a new chat with `text` ready to send, on this server. */
export function promptLink(origin: string, text: string): string {
  return `${origin}/?prompt=${encodeURIComponent(text.slice(0, MAX_LINKED_PROMPT))}`;
}
