#!/usr/bin/env node
// See one part of the web UI and measure it: a screenshot of the element a
// selector names, and the size, radius, padding, and font of every control
// inside it. Sizes that disagree (a 30 px pill beside a 34 px button) are the
// usual cause of a part that "looks off", and they are easier to read as
// numbers than to spot in a picture.
//
//   node scripts/ui-shot.mjs <url> <selector> <out.png> [--phone|--narrow] [--light]
//
// <url> is any page of a running server: the dev server (npm run dev, :5173)
// or a sandbox one with fake harnesses (docs/ui.md). Add #chat=<id> to open a
// chat. Run it inside `devenv shell` on NixOS, where PLAYWRIGHT_BROWSERS_PATH
// names nixpkgs' browsers (never `npx playwright install`). It only reads: it
// clicks nothing and sends nothing.
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const [url, selector, out] = args.filter((a) => !a.startsWith("--"));
if (!url || !selector || !out) {
  console.error("usage: node scripts/ui-shot.mjs <url> <selector> <out.png> [--phone|--narrow] [--light]");
  process.exit(2);
}
// The same three viewports as tests/e2e/screenshots.spec.ts.
const viewport = args.includes("--narrow") ? { width: 320, height: 640 } : args.includes("--phone") ? { width: 390, height: 844 } : { width: 1360, height: 860 };

const browser = await chromium.launch();
try {
  // bypassCSP: the app's strict CSP would otherwise refuse a style a caller injects to compare a change.
  const page = await browser.newPage({ viewport, colorScheme: args.includes("--light") ? "light" : "dark", bypassCSP: true });
  await page.goto(url);
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible", timeout: 20_000 });
  // Let entrance motion finish so sizes are the resting ones.
  await page.waitForTimeout(800);
  const rows = await target.evaluate((root) => {
    const controls = [root, ...root.querySelectorAll("button, a, input, textarea, select, [role=button], [role=status]")];
    return controls
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        const name = (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
        const cls = String(e.className).split(" ").filter(Boolean).slice(0, 2).join(".");
        return `${`${e.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`.padEnd(40)} ${name.padEnd(24)} ${`${Math.round(r.width)}x${Math.round(r.height)}`.padEnd(9)} radius ${cs.borderRadius.padEnd(6)} pad ${cs.padding.padEnd(15)} font ${cs.fontSize}`;
      });
  });
  console.log(rows.join("\n"));
  await target.screenshot({ path: out });
  console.log(`\n${out}`);
} finally {
  await browser.close();
}
