// SSE client with an explicit reconnect policy, because phones sleep tabs:
// jittered backoff 0.5s→10s (then stay at the cap), a heartbeat watchdog,
// pause while offline, immediate retry on `online` / tab visible. A new
// EventSource does not send Last-Event-ID, so the last id goes in the query.
import type { ChatEvent } from "../shared/protocol.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

const TIERS_MS = [500, 1000, 2000, 4000, 8000, 10_000];
const HEARTBEAT_DEAD_MS = 45_000;

export interface StreamHandlers {
  onEvent(event: ChatEvent): void;
  onState(state: ConnectionState): void;
  /** The chat no longer exists (404) or the browser is signed out (401). */
  onGone(status: number): void;
}

export class ChatStream {
  private es: EventSource | null = null;
  private lastId: number | null = null;
  private attempt = 0;
  private retryTimer: number | null = null;
  private watchdog: number | null = null;
  private lastAlive = Date.now();
  private stopped = false;

  constructor(
    private readonly chatId: string,
    private readonly handlers: StreamHandlers,
  ) {}

  start(): void {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisible);
    this.watchdog = window.setInterval(() => {
      if (this.es && Date.now() - this.lastAlive > HEARTBEAT_DEAD_MS) this.reconnectNow();
    }, 5000);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.es?.close();
    this.es = null;
  }

  private setState(state: ConnectionState): void {
    if (!this.stopped) this.handlers.onState(state);
  }

  private connect(): void {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.setState("disconnected");
      return;
    }
    this.setState(this.attempt === 0 && this.lastId === null ? "connecting" : "reconnecting");
    const query = this.lastId !== null ? `?lastEventId=${this.lastId}` : "";
    const es = new EventSource(`/api/chats/${encodeURIComponent(this.chatId)}/events${query}`);
    this.es = es;
    this.lastAlive = Date.now();
    es.addEventListener("open", () => {
      this.attempt = 0;
      this.lastAlive = Date.now();
      this.setState("connected");
    });
    es.addEventListener("chat", (message) => {
      const msg = message as MessageEvent<string>;
      this.lastAlive = Date.now();
      let event: ChatEvent;
      try {
        event = JSON.parse(msg.data) as ChatEvent;
      } catch {
        // Leave lastId untouched so a reconnect replays this frame.
        return;
      }
      if (msg.lastEventId) this.lastId = Number(msg.lastEventId);
      this.handlers.onEvent(event);
      if (event.type === "disposed") this.stop();
    });
    es.addEventListener("heartbeat", () => {
      this.lastAlive = Date.now();
    });
    es.addEventListener("error", () => {
      if (this.es !== es) return;
      es.close();
      this.es = null;
      void this.afterError();
    });
  }

  /** Distinguish "gone" (404/401) from a transient drop before retrying. */
  private async afterError(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(this.chatId)}`, { cache: "no-store", credentials: "same-origin" });
      if (res.status === 404 || res.status === 401) {
        this.setState("disconnected");
        this.handlers.onGone(res.status);
        this.stop();
        return;
      }
    } catch {
      // network down: fall through to backoff
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.setState("disconnected");
      return;
    }
    const tier = TIERS_MS[Math.min(this.attempt, TIERS_MS.length - 1)] as number;
    this.attempt += 1;
    const delay = tier * (0.5 + Math.random() * 0.5);
    this.setState("reconnecting");
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.stopped) return;
    this.es?.close();
    this.es = null;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private onOnline = () => this.reconnectNow();

  private onOffline = () => {
    this.es?.close();
    this.es = null;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setState("disconnected");
  };

  private onVisible = () => {
    if (document.visibilityState === "visible" && !this.es) this.reconnectNow();
  };
}
