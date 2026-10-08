// One clock for every spinner and running timer on screen.
import { createSignal } from "solid-js";

const [tick, setTick] = createSignal(0);
let timer: ReturnType<typeof setInterval> | null = null;

export function startTicker(): void {
  timer ??= setInterval(() => setTick((n) => n + 1), 100);
  (timer as { unref?: () => void }).unref?.();
}

export function stopTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export { tick };
