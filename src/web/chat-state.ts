// Client-side fold of the chat event stream, reconciled by item id.
import type { ChatEvent, ChatItem, ChatSnapshot } from "../shared/protocol.js";

export type ChatState = ChatSnapshot & { gone?: string };

export function applyEvents(state: ChatState | null, events: ChatEvent[]): ChatState | null {
  const index = new Map<string, number>();
  if (state) indexItems(index, state.items);
  let next = state;
  for (const event of events) next = apply(next, event, index);
  return next;
}

/** id → position, first occurrence wins (the old `findIndex` semantics). */
function indexItems(index: Map<string, number>, items: ChatItem[]): void {
  index.clear();
  items.forEach((item, i) => {
    if (!index.has(item.id)) index.set(item.id, i);
  });
}

function replaceItem(items: ChatItem[], item: ChatItem, index: Map<string, number>): ChatItem[] {
  const at = index.get(item.id);
  if (at === undefined) {
    index.set(item.id, items.length);
    return [...items, item];
  }
  const copy = items.slice();
  copy[at] = item;
  return copy;
}

function apply(state: ChatState | null, event: ChatEvent, index: Map<string, number>): ChatState | null {
  if (event.type === "snapshot") {
    indexItems(index, event.snapshot.items);
    return { ...event.snapshot };
  }
  if (!state) return state;
  switch (event.type) {
    case "item":
      return { ...state, items: replaceItem(state.items, event.item, index) };
    case "delta": {
      const at = index.get(event.itemId);
      if (at === undefined) return state;
      const item = state.items[at] as ChatItem;
      let updated: ChatItem = item;
      if (item.kind === "assistant" && (event.field === "text" || event.field === "thinking")) {
        updated = { ...item, [event.field]: item[event.field] + event.append };
      } else if (item.kind === "tool" && event.field === "output") {
        updated = { ...item, output: item.output + event.append };
      }
      const items = state.items.slice();
      items[at] = updated;
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
    case "context":
      return { ...state, context: event.context };
    case "usage":
      return { ...state, usage: event.usage };
    case "todos":
      return { ...state, todos: event.todos };
    case "disposed":
      return { ...state, status: "disposed", gone: event.reason };
    default:
      return state;
  }
}
