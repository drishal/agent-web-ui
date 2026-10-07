// Notifications only. There is no fetch handler: the app is never cached here,
// so a rebuild shows on the next reload as before.
//
// A push carries no payload; it only says "something happened". The notes are
// read from the server with this device's cookie, and one is skipped when a
// visible window is already showing its chat.

let cursor = null;
const shown = new Set();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => event.waitUntil(showNotes()));

async function showNotes() {
  let data;
  try {
    const res = await fetch(`/api/notifications${cursor === null ? "" : `?since=${cursor}`}`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  cursor = data.now;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const watching = (chatId) => chatId && windows.some((w) => w.visibilityState === "visible" && new URL(w.url).hash === `#chat=${chatId}`);
  for (const note of data.notes) {
    if (shown.has(note.id) || watching(note.chatId)) continue;
    shown.add(note.id);
    await self.registration.showNotification(note.title, {
      body: note.body,
      tag: note.id,
      data: { chatId: note.chatId, sessionId: note.sessionId },
      requireInteraction: note.kind === "ask",
    });
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { chatId, sessionId } = event.notification.data ?? {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = windows.find((w) => w.focused) ?? windows[0];
      if (target) {
        await target.focus();
        if (chatId) target.postMessage({ type: "open-chat", chatId, sessionId });
        return;
      }
      await self.clients.openWindow(chatId ? `/#chat=${chatId}` : "/");
    })(),
  );
});
