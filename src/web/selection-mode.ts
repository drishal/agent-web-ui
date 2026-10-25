// The sidebar's bulk-selection mode, in a tiny store so the rows read it without
// the list's components threading a prop through every builder (draft-bus.ts's
// pattern). The rules themselves live in session-selection.ts, tested on their own.
import { useEffect, useState } from "react";
import { ranged, toggled } from "./session-selection.js";

export interface SelectionMode {
  on: boolean;
  ids: Set<string>;
  /** The row a Shift-click runs from. */
  anchor: string | null;
}

const OFF: SelectionMode = { on: false, ids: new Set(), anchor: null };
let state: SelectionMode = OFF;
/** The ids in the order the list is showing them, for a Shift-run; kept by the sidebar. */
let order: readonly string[] = [];
const listeners = new Set<() => void>();

function publish(next: SelectionMode): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getSelectionMode(): SelectionMode {
  return state;
}

export function setSelectionOrder(ids: readonly string[]): void {
  order = ids;
}

export function enterSelection(id?: string): void {
  publish({ on: true, ids: new Set(id === undefined ? [] : [id]), anchor: id ?? null });
}

export function leaveSelection(): void {
  publish(OFF);
}

export function toggleSelection(id: string, shift: boolean): void {
  if (!state.on) return;
  const ids = shift ? ranged(order, state.anchor, id) : toggled(state.ids, id);
  publish({ on: true, ids, anchor: id });
}

export function useSelectionMode(): SelectionMode {
  const [mode, setMode] = useState(state);
  useEffect(() => {
    const update = () => setMode(state);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return mode;
}
