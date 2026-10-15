// Text and images for the shown composer's draft from elsewhere on the page:
// a quoted passage, a command's output, what another app shared to awui, a
// prompt link's text, or a project search's @path:line.
// The composer appends it and takes the focus. What arrives while no composer
// is mounted (a share opens the app before its chat exists) waits for the
// next one. Only the main chat's composer listens (`enabled`): the one beside
// it would take a second copy.
import { useEffect, useRef } from "react";

const EVENT = "awui:add-to-draft";
const IMAGES = "awui:add-images-to-draft";
let textListeners = 0;
let imageListeners = 0;
const waitingText: string[] = [];
const waitingImages: File[] = [];
const LINKED = "awui:linked-prompt";
let linkedListeners = 0;
const waitingLinked: LinkedPrompt[] = [];

/** A prompt a link carried: it fills an empty composer with a note to read it first. */
export interface LinkedPrompt {
  text: string;
  /** Hidden characters taken out of it. */
  hidden: number;
}

export function addLinkedPrompt(prompt: LinkedPrompt): void {
  if (linkedListeners === 0) waitingLinked.push(prompt);
  else window.dispatchEvent(new CustomEvent<LinkedPrompt>(LINKED, { detail: prompt }));
}

export function useLinkedPrompt(handler: (prompt: LinkedPrompt) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const listener = (e: Event) => ref.current((e as CustomEvent<LinkedPrompt>).detail);
    window.addEventListener(LINKED, listener);
    linkedListeners++;
    for (const prompt of waitingLinked.splice(0)) ref.current(prompt);
    return () => {
      window.removeEventListener(LINKED, listener);
      linkedListeners--;
    };
  }, [enabled]);
}

export function addToDraft(text: string): void {
  if (textListeners === 0) waitingText.push(text);
  else window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: text }));
}

/** Images for the draft, as if pasted. */
export function addImagesToDraft(files: File[]): void {
  if (files.length === 0) return;
  if (imageListeners === 0) waitingImages.push(...files);
  else window.dispatchEvent(new CustomEvent<File[]>(IMAGES, { detail: files }));
}

export function useAddToDraft(handler: (text: string) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const listener = (e: Event) => ref.current((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, listener);
    textListeners++;
    for (const text of waitingText.splice(0)) ref.current(text);
    return () => {
      window.removeEventListener(EVENT, listener);
      textListeners--;
    };
  }, [enabled]);
}

export function useAddImagesToDraft(handler: (files: File[]) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const listener = (e: Event) => ref.current((e as CustomEvent<File[]>).detail);
    window.addEventListener(IMAGES, listener);
    imageListeners++;
    const waiting = waitingImages.splice(0);
    if (waiting.length > 0) ref.current(waiting);
    return () => {
      window.removeEventListener(IMAGES, listener);
      imageListeners--;
    };
  }, [enabled]);
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
