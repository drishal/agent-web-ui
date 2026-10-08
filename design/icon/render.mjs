// Renders the icon SVGs to a preview sheet (and, with --png, to app icon PNGs).
// Usage: node design/icon/render.mjs [--png <svg> <outdir>]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const here = path.dirname(new URL(import.meta.url).pathname);
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });

const args = process.argv.slice(2);
if (args[0] === "--png") {
  const [, src, outDir] = args;
  const svg = readFileSync(src, "utf8");
  const square = svg.replace('rx="112"', 'rx="0"');
  await page.setViewportSize({ width: 512, height: 512 });
  const shots = [
    ["icon-512.png", svg, 512],
    ["icon-192.png", svg, 192],
    ["maskable-512.png", square, 512],
    ["apple-touch-icon.png", square, 180],
  ];
  const p2 = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, body, size] of shots) {
    await p2.setViewportSize({ width: size, height: size });
    await p2.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${body}`);
    await p2.screenshot({ path: path.join(outDir, name), omitBackground: true });
  }
} else {
  const files = ["a-bubble.svg", "b-hub.svg", "c-prompt.svg"];
  const row = (bg, fg) =>
    files
      .map((f) => {
        const svg = readFileSync(path.join(here, f), "utf8");
        const masked = svg.replace('rx="112"', 'rx="0"');
        return `<div class="set" style="background:${bg};color:${fg}">
          <div class="name">${f.replace(".svg", "")}</div>
          <div class="sizes">
            <div style="width:160px;height:160px">${svg}</div>
            <div style="width:64px;height:64px">${svg}</div>
            <div style="width:32px;height:32px">${svg}</div>
            <div style="width:16px;height:16px">${svg}</div>
            <div class="circle" style="width:96px;height:96px">${masked}</div>
          </div></div>`;
      })
      .join("");
  const html = `<style>
    body{margin:0;font:600 14px system-ui;display:grid;gap:0}
    .row{display:flex}
    .set{padding:20px 24px;flex:1}
    .name{margin-bottom:12px;opacity:.7}
    .sizes{display:flex;align-items:flex-end;gap:16px}
    .sizes svg{width:100%;height:100%;display:block}
    .circle{border-radius:50%;overflow:hidden}
  </style>
  <div class="row">${row("#0f1115", "#f5f6f7")}</div>
  <div class="row">${row("#f2f3f5", "#0f1115")}</div>`;
  await page.setViewportSize({ width: 1380, height: 520 });
  await page.setContent(html);
  await page.screenshot({ path: path.join(here, "preview.png"), fullPage: true });
}
await browser.close();
