import { useEffect, useState } from "react";
import type { InteractionAnswer, InteractionRequest } from "../../shared/protocol.js";

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  return <span className="request-countdown">{seconds}s left</span>;
}

/** A pending harness request; it takes over the composer area until answered. */
export function RequestCard({
  request,
  onAnswer,
  busy,
}: {
  request: InteractionRequest;
  onAnswer: (answer: InteractionAnswer) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const isApproval = request.kind === "select" && request.options?.join("|") === "Approve|Deny";
  return (
    <section className="request-card" aria-label="The agent is waiting for you" role="group">
      <header className="request-head">
        <span className="request-kind">{request.kind === "confirm" || isApproval ? "Approval needed" : "Input needed"}</span>
        {request.expiresAt ? <Countdown expiresAt={request.expiresAt} /> : null}
      </header>
      <pre className="request-title">{request.title}</pre>
      {request.message ? <pre className="request-message">{request.message}</pre> : null}
      {request.kind === "confirm" ? (
        <div className="request-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onAnswer({ kind: "confirm", confirmed: true })}>
            Approve
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => onAnswer({ kind: "confirm", confirmed: false })}>
            Deny
          </button>
        </div>
      ) : null}
      {request.kind === "select" ? (
        <div className={`request-actions${(request.options?.length ?? 0) > 3 ? " is-list" : ""}`}>
          {(request.options ?? []).map((option, i) => (
            <button
              key={`${i}:${option}`}
              type="button"
              className={`btn${i === 0 ? " btn-primary" : ""}`}
              disabled={busy}
              onClick={() => onAnswer({ kind: "select", value: option })}
            >
              {option}
            </button>
          ))}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onAnswer({ kind: "cancel" })}>
            Dismiss
          </button>
        </div>
      ) : null}
      {request.kind === "input" || request.kind === "editor" ? (
        <form
          className="request-form"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(request.kind === "input" ? { kind: "input", value } : { kind: "editor", value });
          }}
        >
          {request.kind === "input" ? (
            <input
              className="input"
              value={value}
              placeholder={request.placeholder ?? ""}
              onChange={(e) => setValue(e.target.value)}
              aria-label={request.title}
              autoFocus
            />
          ) : (
            <textarea className="input request-editor" value={value} onChange={(e) => setValue(e.target.value)} aria-label={request.title} rows={8} autoFocus />
          )}
          <div className="request-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Submit
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onAnswer({ kind: "cancel" })}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
