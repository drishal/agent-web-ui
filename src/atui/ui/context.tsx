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

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
