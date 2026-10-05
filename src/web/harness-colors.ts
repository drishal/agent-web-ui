// Harness colours come from the server (HarnessStatus.accent, a theme token),
// so a new adapter needs no CSS: each harness gets a root variable
// `--harness-<id>`, and an element points its own `--harness` at it.
import type { CSSProperties } from "react";
import type { HarnessStatus } from "../shared/protocol.js";

const TOKEN = /^[a-z0-9-]{1,32}$/;

/** Set `--harness-<id>` on the root for every harness (CSSOM, so the CSP's style-src allows it). */
export function applyHarnessAccents(harnesses: HarnessStatus[]): void {
  const root = document.documentElement.style;
  for (const h of harnesses) {
    if (TOKEN.test(h.id) && TOKEN.test(h.accent)) root.setProperty(`--harness-${h.id}`, `var(--${h.accent})`);
  }
}

/** Style that colours an element (dot, badge, spinner, chip) as this harness; muted when unknown. */
export function harnessColor(id: string | undefined): CSSProperties {
  if (!id || !TOKEN.test(id)) return {};
  return { "--harness": `var(--harness-${id}, var(--muted))` } as CSSProperties;
}
