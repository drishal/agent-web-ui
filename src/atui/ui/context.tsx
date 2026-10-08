// The app's state and its theme, for every component below App.
import { createContext, useContext, type Accessor } from "solid-js";
import type { Atui } from "../state.js";
import type { Theme } from "../theme.js";

export const AtuiContext = createContext<Atui>();

export function useAtui(): Atui {
  const app = useContext(AtuiContext);
  if (!app) throw new Error("atui: no app in context");
  return app;
}

export function useTheme(): Accessor<Theme> {
  return useAtui().theme;
}

/** One glyph per tool category, OpenCode's way: a quiet mark before the tool's name. */
export const TOOL_MARK: Record<string, string> = {
  read: "→",
  search: "⌕",
  edit: "✎",
  write: "✎",
  command: "$",
  web: "◍",
  agent: "◆",
  other: "•",
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
