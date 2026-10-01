// Client-side fold of the chat event stream, reconciled by item id.
import type { ChatEvent, ChatItem, ChatSnapshot } from "../shared/protocol.js";

export type ChatState = ChatSnapshot & { gone?: string };

export function applyEvents(state: ChatState | null, events: ChatEvent[]): ChatState | null {
  let next = state;
  for (const event of events) next = apply(next, event);
  return next;
}

function replaceItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) return [...items, item];
  const copy = items.slice();
  copy[index] = item;
  return copy;
}

function apply(state: ChatState | null, event: ChatEvent): ChatState | null {
  if (event.type === "snapshot") return { ...event.snapshot };
  if (!state) return state;
  switch (event.type) {
    case "item":
      return { ...state, items: replaceItem(state.items, event.item) };
    case "delta": {
      const index = state.items.findIndex((i) => i.id === event.itemId);
      if (index === -1) return state;
      const item = state.items[index] as ChatItem;
      let updated: ChatItem = item;
      if (item.kind === "assistant" && (event.field === "text" || event.field === "thinking")) {
        updated = { ...item, [event.field]: item[event.field] + event.append };
      } else if (item.kind === "tool" && event.field === "output") {
        updated = { ...item, output: item.output + event.append };
      }
      const items = state.items.slice();
      items[index] = updated;
      return { ...state, items };
    }
    case "status":
      return { ...state, status: event.status };
    case "queue":
      return { ...state, queue: event.queue };
    case "config":
      return { ...state, config: event.config };
    case "title":
      return { ...state, title: event.title, sessionId: event.sessionId };
    case "request":
      return state.pending.some((p) => p.id === event.request.id)
        ? state
        : { ...state, pending: [...state.pending, event.request] };
    case "request_resolved":
      return { ...state, pending: state.pending.filter((p) => p.id !== event.requestId) };
    case "extension_status": {
      const extensionStatus = { ...state.extensionStatus };
      if (event.text === null) delete extensionStatus[event.key];
      else extensionStatus[event.key] = event.text;
      return { ...state, extensionStatus };
    }
    case "disposed":
      return { ...state, status: "disposed", gone: event.reason };
    default:
      return state;
  }
}
