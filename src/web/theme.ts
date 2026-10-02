// Theme application through the CSSOM (style.setProperty), never injected
// <style> text, so the CSP needs no 'unsafe-inline'.
import type { Bootstrap, ThemeInfo } from "../shared/protocol.js";
import { api } from "./api.js";
import { load, save } from "./storage.js";

export type ThemeMode = "system" | "light" | "dark" | "scheme";

let applied: string[] = [];

function setMetaThemeColor(color: string | null): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const fallback = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#1b1d22";
  meta.setAttribute("content", color ?? fallback);
}

export function applyTheme(mode: ThemeMode, info: ThemeInfo | null): void {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  applied = [];
  const useScheme = mode === "scheme" && info?.source === "file";
  if (useScheme && info) {
    for (const [name, value] of Object.entries(info.vars)) {
      root.style.setProperty(name, value);
      applied.push(name);
    }
    if (info.fonts.sans) {
      root.style.setProperty("--font-sans", `"${info.fonts.sans}", system-ui, -apple-system, "Segoe UI", sans-serif`);
      applied.push("--font-sans");
    }
    if (info.fonts.mono) {
      root.style.setProperty("--font-mono", `"${info.fonts.mono}", ui-monospace, "SFMono-Regular", Menlo, monospace`);
      applied.push("--font-mono");
    }
    root.dataset.theme = info.polarity ?? "dark";
    root.dataset.scheme = "1";
  } else {
    delete root.dataset.scheme;
    if (mode === "light" || mode === "dark") root.dataset.theme = mode;
    else delete root.dataset.theme;
  }
  setMetaThemeColor(useScheme ? info?.themeColor ?? null : null);
}

type ThemeChoice = Bootstrap["ui"]["theme"];

/** config.yml's theme as a mode; "base16" needs a theme.yml to show. */
function configMode(choice: ThemeChoice, info: ThemeInfo | null): ThemeMode | null {
  if (choice === "base16") return info?.source === "file" ? "scheme" : "system";
  return choice;
}

/**
 * This device's theme: its own pick from the menu, else config.yml's theme,
 * else theme.yml when there is one. A changed config.yml theme wins once, so
 * editing the file is never shadowed by an old pick.
 */
export function storedThemeMode(info: ThemeInfo | null, choice: ThemeChoice = null): ThemeMode {
  if (choice !== null && choice !== load<ThemeChoice>("themeConfig", null)) {
    save("themeConfig", choice);
    save("theme", null);
  }
  const fallback = configMode(choice, info) ?? (info?.source === "file" ? "scheme" : "system");
  const stored = load<ThemeMode | null>("theme", null);
  if (stored === "scheme" && info?.source !== "file") return fallback === "scheme" ? "system" : fallback;
  return stored ?? fallback;
}

export function storeThemeMode(mode: ThemeMode): void {
  save("theme", mode);
}

export async function fetchTheme(): Promise<ThemeInfo | null> {
  try {
    return await api<ThemeInfo>("/api/theme");
  } catch {
    return null;
  }
}
