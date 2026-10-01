import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AssistantItem, ChatItem, NoticeItem, RequestItem, ToolItem } from "../../shared/protocol.js";
import { Markdown } from "./Markdown.js";

const PIN_DISTANCE_PX = 96;

const Assistant = memo(function Assistant({ item }: { item: AssistantItem }) {
  return (
    <article className={`msg msg-assistant${item.streaming ? " is-streaming" : ""}`} aria-busy={item.streaming}>
      {item.thinking ? (
        <details className="thinking">
          <summary>
            <span className="thinking-dot" aria-hidden="true" />
            {item.streaming && !item.text ? "Thinking…" : "Thinking"}
          </summary>
          <div className="thinking-body">{item.thinking}</div>
        </details>
      ) : null}
      {item.text ? <Markdown text={item.text} /> : item.streaming && !item.thinking ? <span className="typing">…</span> : null}
      {item.error ? <p className={`msg-error${item.error === "Stopped" ? " is-stopped" : ""}`}>{item.error}</p> : null}
    </article>
  );
});

const Tool = memo(function Tool({ item }: { item: ToolItem }) {
  const label = item.status === "running" ? "running" : item.status === "error" ? "failed" : "done";
  return (
    <details className={`tool tool-${item.status}`}>
      <summary>
        <span className="tool-icon" aria-hidden="true">
          {item.status === "running" ? "◌" : item.status === "error" ? "✕" : "✓"}
        </span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-brief">{brief(item.args)}</span>
        <span className="tool-status">{label}</span>
      </summary>
      <div className="tool-body">
        {item.args ? (
          <>
            <div className="tool-label">Input</div>
            <pre>{item.args}</pre>
          </>
        ) : null}
        <div className="tool-label">Output{item.truncated ? " (truncated)" : ""}</div>
        <pre>{item.output || (item.status === "running" ? "…" : "(empty)")}</pre>
      </div>
    </details>
  );
});

function brief(args: string): string {
  const oneLine = args.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

function Notice({ item }: { item: NoticeItem }) {
  return (
    <div className={`notice notice-${item.level}`} role={item.level === "error" ? "alert" : undefined}>
      {item.text}
    </div>
  );
}

function RequestRecord({ item }: { item: RequestItem }) {
  return (
    <div className="request-record">
      <span className="request-record-title">{item.request.title}</span>
      <span className="request-record-outcome">{item.outcome ?? "Waiting for you…"}</span>
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <article className="msg msg-user">
          <div className="msg-user-text">{item.text}</div>
          {item.imageCount ? <div className="msg-meta">{item.imageCount} image(s)</div> : null}
        </article>
      );
    case "assistant":
      return <Assistant item={item} />;
    case "tool":
      return <Tool item={item} />;
    case "notice":
      return <Notice item={item} />;
    case "request":
      return <RequestRecord item={item} />;
  }
}

export function Conversation({ items, empty }: { items: ChatItem[]; empty: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distance <= PIN_DISTANCE_PX;
    setShowJump(!pinned.current);
  }, []);

  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setShowJump(false);
  }, []);

  useLayoutEffect(() => {
    if (pinned.current) {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
  }, [items]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="conversation-wrap">
      <div className="conversation" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        <div className="conversation-inner">
          {items.length === 0 ? empty : items.map((item) => <Item key={item.id} item={item} />)}
        </div>
      </div>
      {showJump ? (
        <button type="button" className="jump" onClick={jump}>
          Jump to latest ↓
        </button>
      ) : null}
    </div>
  );
}
