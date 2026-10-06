// Resuming from the session file: the chat shows at once, marked Starting,
// while the harness starts behind it.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSubscriber } from "../../src/server/chats/chat.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { ChatEvent, ChatStatus } from "../../src/shared/protocol.js";

const ws = { id: "w", path: "/p", name: "p" };
const managers: ChatManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});

async function until(predicate: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A stored session with one finished turn, then an adapter that takes `delay` ms to resume it. */
async function storedSession(delay: number) {
  const adapter = new FakeAdapter({ chunkDelayMs: 1, resumeDelayMs: delay });
  const live = await adapter.openChat({ cwd: ws.path });
  let settled = false;
  live.subscribe((e) => {
    if (e.type === "settled") settled = true;
  });
  await live.prompt("remember me");
  await until(() => settled);
  await live.dispose();
  const manager = new ChatManager();
  managers.push(manager);
  return { adapter, manager, nativeId: live.nativeId as string };
}

function statuses(chat: { subscribe(s: ChatSubscriber): () => void }): ChatStatus[] {
  const seen: ChatStatus[] = [];
  chat.subscribe({ send: (_id: number, e: ChatEvent) => void (e.type === "status" && seen.push(e.status)), close: () => undefined });
  return seen;
}

describe("resume from the session file", () => {
  it("shows the transcript at once, Starting, then Idle with the harness's config", async () => {
    const { manager, adapter, nativeId } = await storedSession(300);
    const t0 = Date.now();
    const chat = await manager.resume(adapter, ws, nativeId);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(chat.status).toBe("starting");
    expect(chat.snapshot().items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(chat.snapshot().config.model).toBeNull();
    await until(() => chat.status === "idle");
    expect(chat.snapshot().config.model).toBe("fake/echo");
    expect(chat.snapshot().config.models.length).toBeGreaterThan(0);
  });

  it("a prompt sent while starting runs once the harness is up, with no Idle in between", async () => {
    const { manager, adapter, nativeId } = await storedSession(200);
    const chat = await manager.resume(adapter, ws, nativeId);
    const seen = statuses(chat);
    await chat.send("and again", "normal");
    expect(chat.status).toBe("running");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes("Echo: and again")));
    expect(seen).toEqual(["running", "idle"]);
  });

  it("applies a model change made while starting", async () => {
    const { manager, adapter, nativeId } = await storedSession(150);
    const chat = await manager.resume(adapter, ws, nativeId);
    await chat.setConfig({ model: "fake/slow" });
    expect(chat.snapshot().config.model).toBe("fake/slow");
  });

  it("keeps the transcript and shows the error when the harness fails to start", async () => {
    const { manager, adapter, nativeId } = await storedSession(50);
    adapter.openChat = async () => {
      throw new Error("no such binary");
    };
    const chat = await manager.resume(adapter, ws, nativeId);
    await until(() => chat.status === "error");
    const snap = chat.snapshot();
    expect(snap.items.filter((i) => i.kind !== "notice").map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items.find((i) => i.kind === "notice")).toMatchObject({ level: "error", text: expect.stringContaining("no such binary") });
  });

  it("closes the harness that arrives after its chat was closed", async () => {
    const { manager, adapter, nativeId } = await storedSession(150);
    const open = adapter.openChat.bind(adapter);
    let started: LiveChat | null = null;
    let disposed = false;
    adapter.openChat = async (req) => {
      const live = await open(req);
      const dispose = live.dispose.bind(live);
      live.dispose = async () => {
        disposed = true;
        await dispose();
      };
      started = live;
      return live;
    };
    const chat = await manager.resume(adapter, ws, nativeId);
    await chat.dispose("closed while starting");
    await until(() => started !== null && disposed);
  });
});
