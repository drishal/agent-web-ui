// The page notices when the server moved to a build other than the one it loaded.
// An installed app has no reload button, and iOS drops pull-to-refresh, so a
// deploy would otherwise reach it only when the app is killed: the build id this
// page started with (index.html's hash, from the bootstrap) is remembered, and
// later checks compare it with the server's — on an SSE reconnect (which means
// the server restarted), whenever the page becomes visible again, and every few
// minutes while it is. A mismatch raises the reload banner; nothing reloads on
// its own, because a run may be going and a draft may be half typed.
import { useSyncExternalStore } from "react";

/** How often a visible page asks, should no reconnect or visibility change come. */
const POLL_MS = 5 * 60_000;
/** How long to wait for a new service worker to take over before reloading anyway. */
const TAKEOVER_MS = 2000;

let loaded = "";
let stale = false;
const listeners = new Set<() => void>();

/** The build this page was served from; the first one wins. */
export function rememberBuild(build: string | undefined): void {
  if (!loaded && build) loaded = build;
}

/** Ask the server what it serves now, and raise the banner when it is not what this page loaded. */
export async function checkForNewBuild(): Promise<void> {
  if (!loaded || stale) return;
  try {
    const res = await fetch("/api/health", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return;
    const { build } = (await res.json()) as { build?: string };
    if (!build || build === loaded) return;
    stale = true;
    for (const notify of listeners) notify();
  } catch {
    // Offline: the next check, or the reconnect that follows, tries again.
  }
}

/** Watch for a deploy while the page stays open. Returns the cleanup. */
export function watchForNewBuild(): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") void checkForNewBuild();
  };
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(onVisible, POLL_MS);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}

export function useNewBuild(): boolean {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => stale,
    () => false,
  );
}

/**
 * Load the build the server has now. A newer service worker must take over
 * first, or an installed iOS app reloads into the same old worker (it ignores
 * skipWaiting from install, see public/sw.js); the wait is capped so a stuck
 * worker cannot trap the page.
 */
export async function reloadApp(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      // Give the browser the chance to find the worker this deploy brought first.
      await registration.update().catch(() => undefined);
      if (registration.waiting) {
        const taken = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
        await Promise.race([taken, new Promise((resolve) => window.setTimeout(resolve, TAKEOVER_MS))]);
      }
    }
  } catch {
    // No worker, or a browser without one: a plain reload still fetches the new page.
  }
  location.reload();
}
