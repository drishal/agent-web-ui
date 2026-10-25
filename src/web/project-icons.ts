// A project's icon on this device: a glyph the user picks, kept in browser storage
// beside the other per-device settings. A tiny subscription lets the badge that
// draws it update the moment the picker saves (draft-bus.ts's pattern).
import { useEffect, useState } from "react";
import { load, save } from "./storage.js";

const KEY = "projectIcons";
const listeners = new Set<() => void>();

export function readIcons(): Record<string, string> {
  return load<Record<string, string>>(KEY, {});
}

/** A glyph of one or two characters, or null to go back to the monogram. */
export function setProjectIcon(id: string, icon: string | null): void {
  const next = { ...readIcons() };
  const clean = (icon ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 2);
  if (clean) next[id] = clean;
  else delete next[id];
  save(KEY, next);
  for (const listener of listeners) listener();
}

export function useProjectIcons(): Record<string, string> {
  const [icons, setIcons] = useState(readIcons);
  useEffect(() => {
    const update = () => setIcons(readIcons());
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return icons;
}
