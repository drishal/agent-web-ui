// One collapsible stack above the composer for queued messages, todos, and
// extension status (after Hermes Desktop's composer status stack). Todos and
// the queue start open; extension status starts folded. Hiding is per chat.
import { useEffect, useState } from "react";
import type { QueueState, TodoItem } from "../../shared/protocol.js";
import { IconCheck, IconChevronDown, IconCircle, IconQueue, IconSteer, Spinner } from "../icons.js";
import { load, save } from "../storage.js";

function TodoIcon({ status }: { status: string }) {
  if (/done|complete/.test(status)) return <IconCheck size={13} />;
  if (/progress|active|doing/.test(status)) return <Spinner size={12} />;
  return <IconCircle size={13} />;
}

function Group({
  title,
  meta,
  defaultOpen,
  children,
}: {
  title: string;
  meta?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`stack-group${open ? " is-open" : ""}`}>
      <button type="button" className="stack-group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconChevronDown size={12} className="stack-chevron" />
        <span>{title}</span>
        {meta ? <span className="stack-meta">{meta}</span> : null}
      </button>
      {open ? <div className="stack-group-body">{children}</div> : null}
    </div>
  );
}

export function StatusStack({
  chatId,
  queue,
  todos,
  extensionStatus,
  base,
}: {
  chatId: string;
  queue: QueueState;
  todos: TodoItem[];
  extensionStatus: Record<string, string>;
  /** Always shown under the rest, even when it is hidden (the git row). */
  base?: React.ReactNode;
}) {
  const key = `stack.${chatId}`;
  const [hidden, setHidden] = useState(() => load<boolean>(key, false));
  useEffect(() => setHidden(load<boolean>(key, false)), [key]);
  const statuses = Object.entries(extensionStatus).filter(([, v]) => v.trim());
  const queued = [...queue.steering.map((t) => ({ t, k: "Steering" })), ...queue.followUp.map((t) => ({ t, k: "Follow-up" }))];
  const count = queued.length + (todos.length > 0 ? 1 : 0) + (statuses.length > 0 ? 1 : 0);
  if (count === 0) return base ? <div className="status-stack is-base-only">{base}</div> : null;
  const done = todos.filter((t) => /done|complete/.test(t.status)).length;

  return (
    <div className={`status-stack${hidden ? " is-hidden" : ""}`} data-testid="status-stack">
      <button
        type="button"
        className="stack-ridge"
        aria-expanded={!hidden}
        aria-label={hidden ? "Show status" : "Hide status"}
        onClick={() => {
          setHidden(!hidden);
          save(key, !hidden);
        }}
      >
        <span className="ridge-bar" aria-hidden="true" />
        {hidden ? <span className="ridge-count">{count}</span> : null}
      </button>
      {!hidden ? (
        <div className="stack-body">
          {queued.length > 0 ? (
            <ul className="stack-queue" aria-label="Queued messages">
              {queued.map((q, i) => (
                <li key={`${q.k}${i}`} className="stack-row" data-testid="queue-row">
                  <span className="stack-icon">{q.k === "Steering" ? <IconSteer size={13} /> : <IconQueue size={13} />}</span>
                  <span className="stack-kind">{q.k}</span>
                  <span className="stack-text">{q.t}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {todos.length > 0 ? (
            <Group title="Todos" meta={`${done}/${todos.length}`} defaultOpen>
              <ul className="stack-list">
                {todos.map((todo, i) => (
                  <li key={`${i}:${todo.text}`} className={`stack-row todo-${todo.status.replace(/[^a-z_]/gi, "")}`}>
                    <span className="stack-icon">
                      <TodoIcon status={todo.status} />
                    </span>
                    <span className="stack-text">{todo.text}</span>
                    {todo.phase && todo.phase !== todos[i - 1]?.phase ? <span className="stack-meta">{todo.phase}</span> : null}
                  </li>
                ))}
              </ul>
            </Group>
          ) : null}
          {statuses.length > 0 ? (
            <Group title="Extensions" meta={String(statuses.length)} defaultOpen={false}>
              <ul className="stack-list">
                {statuses.map(([k, v]) => (
                  <li key={k} className="stack-row stack-ext">
                    <span className="stack-kind">{k.replace(/^widget:/, "")}</span>
                    <span className="stack-text">{v}</span>
                  </li>
                ))}
              </ul>
            </Group>
          ) : null}
        </div>
      ) : null}
      {base}
    </div>
  );
}
