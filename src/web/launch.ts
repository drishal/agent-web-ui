// What the app is opened to do, from its URL: the home-screen shortcuts
// (?new=1 a new chat, ?sessions=1 the session list), a share from another app
// (?share=1: the service worker kept the shared text and images in its cache;
// they go into a new chat's composer), and a prompt link (?prompt=…: its text
// goes into a new chat's composer to be read; a link never sends). The query
// is dropped once read, so a reload does not do it again.
import { useEffect, useRef } from "react";
import { addImagesToDraft, addLinkedPrompt, addToDraft } from "./draft-bus.js";
import { linkedPrompt } from "./prompt-link.js";
import { worker } from "./notify.js";

const SHARE_CACHE = "awui-share";

/** The shared text and images the service worker kept, read once and cleared. */
async function takeShare(): Promise<{ text: string; images: File[] }> {
  if (!("caches" in window)) return { text: "", images: [] };
  const cache = await caches.open(SHARE_CACHE);
  const text = (await (await cache.match("/share/text"))?.text()) ?? "";
  const count = Number((await (await cache.match("/share/count"))?.text()) ?? "0") || 0;
  const images: File[] = [];
  for (let i = 0; i < count; i++) {
    const res = await cache.match(`/share/image/${i}`);
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get("x-name") ?? `shared-${i + 1}`);
    images.push(new File([await res.blob()], name, { type: res.headers.get("content-type") ?? "image/png" }));
  }
  await caches.delete(SHARE_CACHE);
  return { text, images };
}

/**
 * `booted`: the app is up (enough to show the sessions). `ready`: a chat can
 * be started too (a project is open), which a new chat or a share waits for.
 */
export function useLaunchActions(opts: { booted: boolean; ready: boolean; newChat: () => Promise<unknown> | void; openSessions: () => void }): void {
  const done = useRef(false);
  const latest = useRef(opts);
  latest.current = opts;
  // Every secure load registers the worker, not only one that turned notifications on: it also takes shares and answers offline.
  useEffect(() => {
    void worker();
  }, []);
  useEffect(() => {
    if (!opts.booted || done.current) return;
    const params = new URLSearchParams(window.location.search);
    const action = params.has("share") ? "share" : params.get("prompt") ? "prompt" : params.has("new") ? "new" : params.has("sessions") ? "sessions" : null;
    if (!action) {
      done.current = true;
      return;
    }
    if (action !== "sessions" && !opts.ready) return;
    done.current = true;
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash);
    if (action === "sessions") return latest.current.openSessions();
    void (async () => {
      const shared = action === "share" ? await takeShare() : null;
      const linked = action === "prompt" ? linkedPrompt(params.get("prompt") ?? "") : null;
      await latest.current.newChat();
      // The new chat's composer, not the one it replaces, takes it: wait for it to mount.
      if (linked?.text.trim()) window.requestAnimationFrame(() => window.requestAnimationFrame(() => addLinkedPrompt(linked)));
      if (shared?.text) addToDraft(shared.text);
      if (shared?.images.length) addImagesToDraft(shared.images);
    })();
  }, [opts.booted, opts.ready]);
}
