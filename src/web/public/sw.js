// The service worker: the notes' push, and the Approve and Deny buttons
// they carry. It never caches the app: a page load goes to the network as
// before, so a rebuild shows on the next reload, and there is no fetch
// handler.
//
// A push carries no payload; it only says "something happened". The notes are
// read from the server with this device's cookie, and one is skipped when a
// visible window is already showing its chat. An approval's note carries its
// two answers, so the notification's Approve and Deny buttons post one with
// that same cookie, without opening the app.
//
// Sharing to awui (the manifest's share_target) arrives as a POST navigation
// from outside the app, which a SameSite=Strict cookie does not ride on, so
// the server could not take it. This worker takes it instead: it keeps the
// shared text and images in its own cache and opens the app, which picks them
// up and puts them in a new chat's composer.

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
      data: { chatId: note.chatId, sessionId: note.sessionId, approval: note.approval ?? null },
      requireInteraction: note.kind === "ask",
      ...(note.approval
        ? {
            actions: [
              { action: "approve", title: "Approve" },
              { action: "deny", title: "Deny" },
            ],
          }
        : {}),
    });
  }
}

/** Send the approval's answer the button chose; say how it went in a short notification. */
async function answer(data, choice) {
  const { chatId, approval } = data;
  let outcome;
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(approval.requestId)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: approval[choice] }),
    });
    outcome = res.ok ? (choice === "approve" ? "Approved" : "Denied") : res.status === 409 ? "Already answered" : res.status === 401 ? "Sign in again to answer" : `Could not answer (HTTP ${res.status})`;
  } catch {
    outcome = "Could not reach the server";
  }
  await self.registration.showNotification(outcome, { tag: `answer-${approval.requestId}`, data: { chatId }, silent: true });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  if ((event.action === "approve" || event.action === "deny") && data.approval) {
    event.waitUntil(answer(data, event.action));
    return;
  }
  const { chatId, sessionId } = data;
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
