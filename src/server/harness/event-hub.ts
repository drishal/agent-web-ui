import type { InteractionAnswer, InteractionRequest } from "../../shared/protocol.js";
import type { HarnessEvent, HarnessEventListener } from "./types.js";

/**
 * Fan-out for adapter events. Events emitted before the first subscriber
 * (startup diagnostics, extension notices) are buffered and replayed to it.
 */
export class EventHub {
  private listeners = new Set<HarnessEventListener>();
  private buffer: HarnessEvent[] | null = [];

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    if (this.buffer) {
      const buffered = this.buffer;
      this.buffer = null;
      for (const event of buffered) listener(event);
    }
    return () => this.listeners.delete(listener);
  }

  emit(event: HarnessEvent): void {
    if (this.buffer) {
      if (this.buffer.length < 500) this.buffer.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  clear(): void {
    this.listeners.clear();
  }
}

interface PendingDialog {
  request: InteractionRequest;
  resolve: (answer: InteractionAnswer | null) => void;
}

/** Tracks open interaction requests for adapters that resolve them in-process. */
export class DialogTracker {
  private pending = new Map<string, PendingDialog>();

  constructor(private readonly hub: EventHub) {}

  open(request: InteractionRequest, signal?: AbortSignal, timeoutMs?: number): Promise<InteractionAnswer | null> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (answer: InteractionAnswer | null, outcome?: string) => {
        if (!this.pending.delete(request.id)) return;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (outcome) this.hub.emit({ type: "request_cancelled", requestId: request.id, outcome });
        resolve(answer);
      };
      const onAbort = () => finish(null, "cancelled");
      if (signal?.aborted) return resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs && timeoutMs > 0) timer = setTimeout(() => finish(null, "Timed out"), timeoutMs);
      this.pending.set(request.id, { request, resolve: (answer) => finish(answer) });
      this.hub.emit({ type: "request", request });
    });
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    const dialog = this.pending.get(requestId);
    if (!dialog) return false;
    dialog.resolve(answer.kind === "cancel" ? null : answer);
    return true;
  }

  cancelAll(): void {
    for (const [id, dialog] of [...this.pending]) {
      this.pending.delete(id);
      this.hub.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
      dialog.resolve(null);
    }
  }
}
