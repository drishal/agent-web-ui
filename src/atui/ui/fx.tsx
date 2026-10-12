// The moving parts every screen shares: the harness's own spinner, the
// shimmering "Working" label, and text revealed at a steady pace while it
// streams (src/atui/fx.ts works out the numbers).
import { createEffect, createSignal, Index, on, onCleanup, type Accessor } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { revealCut, revealStep, scrollPath, shimmer, spinnerFor } from "../fx.js";
import { useAtui, useTheme } from "./context.js";
import { tick } from "./ticker.js";

/** The shown chat's harness spinner (or the one for new chats), in the harness's colour unless told otherwise. */
export function Spinner(p: { harnessId?: string | null; color?: string }) {
  const app = useAtui();
  const t = useTheme();
  const frames = () => spinnerFor(p.harnessId ?? app.chat()?.harnessId ?? app.harnessId());
  return <span style={{ fg: p.color ?? t().accent }}>{frames()[tick() % frames().length]}</span>;
}

/** A label with a soft band of light sweeping across it, for "Working" (Claude Code's status line). */
export function Shimmer(p: { text: string; base?: string; glow?: string }) {
  const t = useTheme();
  const colors = () => shimmer(p.text.length, tick(), p.base ?? t().muted, p.glow ?? t().text);
  const chars = () => [...p.text];
  return <Index each={chars()}>{(ch, i) => <span style={{ fg: colors()[i] }}>{ch()}</span>}</Index>;
}

const FRAME_MS = 33;

/**
 * `text` as it should be on screen: while it streams, revealed at a steady
 * pace (cut at a word, so Markdown is not drawn half-made), finishing the
 * reveal when the stream ends; text that arrives whole, from history, shows
 * at once.
 */
export function usePaced(text: Accessor<string>, streaming: Accessor<boolean>): Accessor<string> {
  const [shown, setShown] = createSignal(streaming() ? 0 : text().length);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  createEffect(
    on([text, streaming], ([value, live]) => {
      // Done while still revealing: finish the reveal rather than jump. Never paced: show it all.
      if (!live && !timer) {
        setShown(value.length);
        return;
      }
      if (shown() > value.length) setShown(value.length);
      timer ??= setInterval(() => {
        const target = text().length;
        const next = revealStep(shown(), target, FRAME_MS);
        setShown(next);
        if (next >= target && !streaming()) stop();
      }, FRAME_MS);
    }),
  );
  onCleanup(stop);
  return () => {
    const value = text();
    const n = shown();
    return n >= value.length ? value : revealCut(value, n);
  };
}

const glides = new WeakMap<ScrollBoxRenderable, { timer: ReturnType<typeof setInterval>; target: number }>();
/** How long an eased jump takes, in frames of 16 ms. */
const GLIDE_FRAMES = 8;

/** Scroll to `to` over a few frames, easing out; a newer glide replaces one still running. Short moves are instant. */
export function glideTo(scroller: ScrollBoxRenderable | undefined, to: number): void {
  if (!scroller) return;
  const from = scroller.scrollTop;
  const target = Math.max(0, Math.min(to, scroller.scrollHeight));
  const running = glides.get(scroller);
  if (running) clearInterval(running.timer);
  glides.delete(scroller);
  if (Math.abs(target - from) <= 2) {
    scroller.scrollTo(target);
    return;
  }
  const path = scrollPath(from, target, GLIDE_FRAMES);
  let i = 0;
  const timer = setInterval(() => {
    scroller.scrollTo(path[i] as number);
    if (++i >= path.length) {
      clearInterval(timer);
      glides.delete(scroller);
    }
  }, 16);
  glides.set(scroller, { timer, target });
}

/** Scroll by `lines`, eased; pressed again mid-glide, it adds to where the glide was going. */
export function glideBy(scroller: ScrollBoxRenderable | undefined, lines: number): void {
  if (scroller) glideTo(scroller, (glides.get(scroller)?.target ?? scroller.scrollTop) + lines);
}
