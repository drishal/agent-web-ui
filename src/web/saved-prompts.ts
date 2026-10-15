// Saved prompts in the browser: the server's list (for every device), read
// once and kept in step for every composer on the page. `#` at the start of a
// composer lists them by name; one replaces the draft, and its `{{blanks}}`
// are filled in (prompt-blanks.ts). The manager dialog opens from anywhere
// through an event, as the file viewer does.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { SavedPrompt } from "../shared/protocol.js";
import { api } from "./api.js";

// ---- the list, shared by every composer and the manager ----------------------------------

let list: SavedPrompt[] | null = null;
let loading: Promise<void> | null = null;
const subscribers = new Set<() => void>();
const notify = () => {
  for (const s of subscribers) s();
};

/** Read the server's list (again). */
export function reloadPrompts(): Promise<void> {
  loading ??= api<{ prompts: SavedPrompt[] }>("/api/prompts")
    .then((r) => {
      list = r.prompts;
      notify();
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function savePrompt(input: { id?: string; name: string; text: string }): Promise<SavedPrompt> {
  const saved = await api<SavedPrompt>("/api/prompts", { body: input });
  await reloadPrompts();
  return saved;
}

export async function removePrompt(id: string): Promise<void> {
  await api(`/api/prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
  await reloadPrompts();
}

/** The saved prompts (null until read), read on first use. */
export function useSavedPrompts(): SavedPrompt[] | null {
  const value = useSyncExternalStore(
    (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
    () => list,
  );
  useEffect(() => {
    if (list === null) void reloadPrompts();
  }, []);
  return value;
}

// ---- opening the manager from anywhere ---------------------------------------------------

const MANAGE = "awui:manage-prompts";

/** Open the manager; `draft` starts a new prompt holding it (Save the draft as a prompt). */
export function managePrompts(draft?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(MANAGE, { detail: draft }));
}

export function useManagePrompts(handler: (draft: string | undefined) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<string | undefined>).detail);
    window.addEventListener(MANAGE, listener);
    return () => window.removeEventListener(MANAGE, listener);
  }, []);
}
