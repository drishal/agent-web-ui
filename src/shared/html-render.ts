// Agent-published HTML pages: a harness's render tool hands the server a
// self-contained document, which is stored with a small bootstrap injected
// into its head. The browser shows it in a sandboxed iframe (an opaque
// origin, `sandbox="allow-scripts allow-forms"`, never `allow-same-origin`)
// and hands it the active theme as CSS custom properties. This module is the
// pure, testable core: the bootstrap markup, the theme payload the frame and
// host exchange over postMessage, and the frame-height fitting math. It must
// stay free of any harness SDK so the server, the web client, and tests can
// all import it.
import {
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE,
  HTML_RENDER_MIN_HEIGHT,
  type HtmlRenderRef,
} from "./protocol.js";

/** The postMessage method the page's bootstrap listens for: the host theme. */
export const HTML_RENDER_THEME_MESSAGE = "awui-html-render/theme";
/** The postMessage method the page posts back: its content height changed. */
export const HTML_RENDER_HEIGHT_MESSAGE = "awui-html-render/height";
/** The postMessage method the page posts when a link or form wants a new tab. */
export const HTML_RENDER_LINK_MESSAGE = "awui-html-render/open-link";
/** The postMessage method the host answers a link request with. */
export const HTML_RENDER_LINK_RESULT = "awui-html-render/link-opened";
/** URL fragment key carrying the first theme, read before any script runs. */
export const HTML_RENDER_THEME_FRAGMENT = "awui-theme";

/** Frame widths the server would measure a page at, phone to wide chat column. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;
/** The reply column's frame width at the default chat width; the height fallback's basis. */
export const HTML_RENDER_COLUMN_WIDTH = 728;
const MAX_MEASURED_HEIGHTS = 24;

/** The theme handed to a page: an appearance plus the CSS variables it reads. */
export interface HtmlRenderTheme {
  appearance: "dark" | "light";
  variables: Record<string, string>;
}

/** The CSS variables a page may read, mirrored from the app's theme tokens. */
const THEME_VARIABLE_KEYS = [
  "--font-sans",
  "--font-mono",
  "--bg",
  "--surface",
  "--surface-2",
  "--border",
  "--text",
  "--text-2",
  "--muted",
  "--accent",
  "--accent-fg",
  "--accent-hover",
  "--link",
  "--danger",
  "--warn",
  "--ok",
  "--info",
  "--orange",
  "--thinking",
] as const;

export const clampHtmlRenderHeight = (height: number): number =>
  Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));

export function htmlRenderTitle(title: unknown): string {
  if (typeof title !== "string") return "HTML";
  const trimmed = title.trim().slice(0, HTML_RENDER_MAX_TITLE);
  return trimmed === "" ? "HTML" : trimmed;
}

/** A safe download/panel file name for a page titled `title`. */
export function htmlRenderFileName(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base === "" ? "page" : base}.html`;
}

function readMeasuredHeights(value: unknown): Array<readonly [number, number]> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) return undefined;
  const heights: Array<readonly [number, number]> = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !Number.isInteger(entry[0]) ||
      (entry[0] as number) < 1 ||
      (entry[0] as number) > 10_000 ||
      typeof entry[1] !== "number" ||
      !Number.isFinite(entry[1])
    ) {
      return undefined;
    }
    heights.push([entry[0] as number, clampHtmlRenderHeight(entry[1] as number)] as const);
  }
  return heights.sort((left, right) => left[0] - right[0]);
}

/**
 * The taller of the heights measured at the nearest widths on each side. A
 * breakpoint between two measured widths can make the page as tall as either.
 */
function measuredHeight(heights: NonNullable<HtmlRenderRef["heights"]>, width: number): number {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width: the page's own reported
 * contentHeight when the client has one, else the server's measurement for
 * that width. The agent's `height` caps it only when it is below the page's
 * height at the column width (a deliberately scrolling frame), or when the
 * page was never measured. A frame shorter than its page would scroll inside
 * the thread and take the reader's scroll, so the frame fits the page.
 */
export function htmlRenderFrameHeight(ref: HtmlRenderRef, width: number, contentHeight?: number): number {
  if (contentHeight !== undefined) return Math.min(clampHtmlRenderHeight(contentHeight), HTML_RENDER_MAX_HEIGHT);
  if (ref.heights && ref.heights.length > 0) return measuredHeight(ref.heights, width);
  return clampHtmlRenderHeight(ref.height);
}

// --- Theme payload ---

/** The theme payload for a frame, built from the app's computed styles. */
export function htmlRenderThemeFromStyles(styles: {
  getPropertyValue(name: string): string;
  getPropertyPriority?(name: string): string;
}): HtmlRenderTheme {
  const variables: Record<string, string> = {};
  for (const key of THEME_VARIABLE_KEYS) {
    const value = styles.getPropertyValue(key).trim();
    if (value !== "") variables[key] = value;
  }
  const scheme = styles.getPropertyValue("color-scheme").trim();
  return { appearance: scheme === "light" ? "light" : "dark", variables };
}

/** The `#fragment` carrying the first theme so a page paints themed from load. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${HTML_RENDER_THEME_FRAGMENT}=${encodeURIComponent(JSON.stringify(theme))}`;
}

// The host posts a theme change as `{ method: HTML_RENDER_THEME_MESSAGE, theme }`
// and answers a link request as `{ method: HTML_RENDER_LINK_RESULT, id }`.

// --- The bootstrap injected into a stored document ---

// Base rules every page gets, after its theme variables. The page lays out
// edge-to-edge in its frame, so its own margins are the only ones that show.
const BASE_CSS =
  "html,body{margin:0;padding:0}" +
  "body{background:var(--bg);color:var(--text);font-family:var(--font-sans);margin:12px}" +
  "pre,code{font-family:var(--font-mono)}::-webkit-scrollbar{width:8px;height:8px}";

// The bootstrap script: read the theme from the URL fragment before first
// paint, then follow `theme` messages; report content height on resize; ask
// the host to open links and forms in a new tab. It writes the theme into a
// `<style id="awui-html-render-theme">` it owns, so a page's own styles win.
const BOOTSTRAP_SCRIPT = `(function(){
var STYLE_ID=${JSON.stringify("awui-html-render-theme")};
var THEME_MSG=${JSON.stringify(HTML_RENDER_THEME_MESSAGE)};
var HEIGHT_MSG=${JSON.stringify(HTML_RENDER_HEIGHT_MESSAGE)};
var LINK_MSG=${JSON.stringify(HTML_RENDER_LINK_MESSAGE)};
var LINK_RESULT=${JSON.stringify(HTML_RENDER_LINK_RESULT)};
var FRAG_KEY=${JSON.stringify(HTML_RENDER_THEME_FRAGMENT)};
var BASE=${JSON.stringify(BASE_CSS)};
var seq=0;
function apply(t){
  if(!t||typeof t!=="object")return;
  var v=t.variables;
  if(!v||typeof v!=="object")return;
  var css=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";
  for(var k in v){if(/^--[a-z0-9-]+$/.test(k))css+=k+":"+String(v[k]).replace(/[;{}<>]/g,"")+";";}
  css+="}"+BASE;
  var s=document.getElementById(STYLE_ID);
  if(!s){s=document.createElement("style");s.id=STYLE_ID;(document.head||document.documentElement).appendChild(s);}
  s.textContent=css;
}
try{
  var m=new RegExp("[#&]"+FRAG_KEY+"=([^&]*)").exec(location.hash);
  if(m){apply(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}
}catch(e){}
window.addEventListener("message",function(e){
  var d=e.data;
  if(d&&typeof d==="object"&&d.method===THEME_MSG)apply(d.theme);
  if(d&&typeof d==="object"&&d.method===LINK_RESULT&&typeof d.id==="number"){
    var cb=pending[d.id];if(cb){delete pending[d.id];cb();}
  }
});
var pending={};
function post(msg){try{parent.postMessage(msg,"*");}catch(e){}}
function reportHeight(){
  var h=Math.ceil(Math.max(
    document.body?document.body.scrollHeight:0,
    document.documentElement?document.documentElement.scrollHeight:0));
  if(h>0)post({method:HEIGHT_MSG,height:h});
}
if(typeof ResizeObserver!=="undefined"){
  new ResizeObserver(reportHeight).observe(document.documentElement);
}
window.addEventListener("load",reportHeight);reportHeight();
document.addEventListener("click",function(e){
  var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
  if(!a)return;
  var href=a.getAttribute("href")||"";
  if(!/^https?:\\/\\//i.test(href))return;
  e.preventDefault();
  var id=++seq;pending[id]=function(){};
  post({method:LINK_MSG,id:id,url:href});
});
})();`;

/**
 * Inserts the theme bootstrap at the start of the document head. A page with
 * no `<head>` still gets it: the markup is prepended to the source. Inert
 * `<head>`s inside comments, strings, or attributes are ignored by scanning
 * only markup outside quotes and comments, so offsets still line up.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const snippet = `<script>${BOOTSTRAP_SCRIPT}</script>`;
  const head = html.search(/<head(\s[^>]*)?>/i);
  if (head === -1) return snippet + html;
  const tagEnd = html.indexOf(">", head);
  if (tagEnd === -1) return snippet + html;
  return html.slice(0, tagEnd + 1) + snippet + html.slice(tagEnd + 1);
}

// --- Wire readers (posted messages, validated) ---

/** The content height a page posted, or undefined for anything else. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.method !== HTML_RENDER_HEIGHT_MESSAGE) return undefined;
  return typeof d.height === "number" && Number.isFinite(d.height) && d.height > 0 ? d.height : undefined;
}

/** A link-open request a page posted, or undefined for anything else. */
export function readHtmlRenderLinkRequest(data: unknown): { id: number; url: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.method !== HTML_RENDER_LINK_MESSAGE) return undefined;
  if (typeof d.id !== "number" || !Number.isInteger(d.id)) return undefined;
  if (typeof d.url !== "string" || !/^https?:\/\//i.test(d.url)) return undefined;
  return { id: d.id, url: d.url };
}

/** Validate an arbitrary object as a theme payload (frame side). */
export function readHtmlRenderTheme(data: unknown): HtmlRenderTheme | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.method !== HTML_RENDER_THEME_MESSAGE) return undefined;
  const t = d.theme;
  if (typeof t !== "object" || t === null) return undefined;
  const appearance = (t as Record<string, unknown>).appearance;
  const variables = (t as Record<string, unknown>).variables;
  if (appearance !== "dark" && appearance !== "light") return undefined;
  if (typeof variables !== "object" || variables === null) return undefined;
  return { appearance, variables: variables as Record<string, string> };
}
