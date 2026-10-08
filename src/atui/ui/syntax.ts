// Markdown and code colours from the theme, for OpenTUI's <markdown> and <code>.
import { RGBA, SyntaxStyle } from "@opentui/core";
import type { Theme } from "../theme.js";

const cache = new Map<string, SyntaxStyle>();

export function syntaxFor(theme: Theme): SyntaxStyle {
  const key = JSON.stringify(theme);
  const hit = cache.get(key);
  if (hit) return hit;
  const c = (hex: string) => RGBA.fromHex(hex);
  const heading = { fg: c(theme.accent), bold: true };
  const style = SyntaxStyle.fromStyles({
    default: { fg: c(theme.text) },
    "markup.heading": heading,
    "markup.heading.1": heading,
    "markup.heading.2": heading,
    "markup.heading.3": heading,
    "markup.heading.4": heading,
    "markup.heading.5": heading,
    "markup.heading.6": heading,
    "markup.strong": { fg: c(theme.text), bold: true },
    "markup.italic": { fg: c(theme.text), italic: true },
    "markup.strikethrough": { fg: c(theme.muted) },
    "markup.raw": { fg: c(theme.rare) },
    "markup.raw.block": { fg: c(theme.text2) },
    "markup.link": { fg: c(theme.link), underline: true },
    "markup.link.label": { fg: c(theme.link) },
    "markup.link.url": { fg: c(theme.muted), underline: true },
    "markup.list": { fg: c(theme.muted) },
    "markup.quote": { fg: c(theme.text2), italic: true },
    keyword: { fg: c(theme.thinking) },
    string: { fg: c(theme.ok) },
    comment: { fg: c(theme.muted), italic: true },
    number: { fg: c(theme.orange) },
    function: { fg: c(theme.link) },
    type: { fg: c(theme.rare) },
  });
  cache.set(key, style);
  return style;
}
