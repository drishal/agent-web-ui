// Pending harness requests take over the composer card (DeepSeek Harness),
// with OpenCode's button order (Deny ghost, Approve primary on the right) and
// Hermes Desktop's stacked silhouettes when more requests are queued.
import { useEffect, useState } from "react";
import type { InteractionAnswer, InteractionRequest } from "../../shared/protocol.js";
import { IconStop } from "../icons.js";

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="approval-countdown">{Math.max(0, Math.round((expiresAt - now) / 1000))}s</span>;
}

function isApproval(r: InteractionRequest): boolean {
  if (r.kind === "confirm") return true;
  const opts = (r.options ?? []).map((o) => o.toLowerCase());
  return r.kind === "select" && opts.length === 2 && opts.includes("approve") && opts.includes("deny");
}

export function ApprovalStack({
  pending,
  busy,
  stopping,
  onAnswer,
  onStop,
}: {
  pending: InteractionRequest[];
  busy: boolean;
  stopping: boolean;
  onAnswer: (request: InteractionRequest, answer: InteractionAnswer) => void;
  onStop: () => void;
}) {
  const request = pending[0] as InteractionRequest;
  const [value, setValue] = useState(request.prefill ?? "");
  useEffect(() => setValue(request.prefill ?? ""), [request.id, request.prefill]);
  const approval = isApproval(request);
  const [headline, ...restLines] = request.title.split("\n");
  const detail = [restLines.join("\n").trim(), request.message?.trim()].filter(Boolean).join("\n\n");
  const behind = Math.min(pending.length - 1, 2);
  const approveValue = request.options?.find((o) => o.toLowerCase() === "approve") ?? "Approve";
  const denyValue = request.options?.find((o) => o.toLowerCase() === "deny") ?? "Deny";

  return (
    <div className={`approval-stack behind-${behind}`} data-testid="approval-card">
      <section className="approval-card" aria-label="The agent is waiting for you" role="group">
        <header className="approval-strip">
          <span className="approval-dot" aria-hidden="true" />
          <span>{approval ? "Waiting for approval" : "Waiting for your answer"}</span>
          {request.expiresAt ? <Countdown expiresAt={request.expiresAt} /> : null}
          {pending.length > 1 ? <span className="approval-more">{pending.length - 1} more</span> : null}
        </header>
        <div className="approval-headline">{headline}</div>
        {detail ? <pre className="approval-detail">{detail}</pre> : null}

        {request.kind === "input" || request.kind === "editor" ? (
          <form
            className="approval-form"
            onSubmit={(e) => {
              e.preventDefault();
              onAnswer(request, request.kind === "input" ? { kind: "input", value } : { kind: "editor", value });
            }}
          >
            {request.kind === "input" ? (
              <input
                className="input"
                value={value}
                placeholder={request.placeholder ?? ""}
                onChange={(e) => setValue(e.target.value)}
                aria-label={headline ?? "Answer"}
                autoFocus
              />
            ) : (
              <textarea className="input approval-editor" value={value} onChange={(e) => setValue(e.target.value)} aria-label={headline ?? "Text"} rows={8} autoFocus />
            )}
            <div className="approval-actions">
              <button type="button" className="btn btn-ghost btn-danger-text" onClick={onStop} disabled={stopping}>
                <IconStop size={12} /> {stopping ? "Stopping…" : "Stop"}
              </button>
              <span className="approval-spacer" />
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onAnswer(request, { kind: "cancel" })}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Submit
              </button>
            </div>
          </form>
        ) : (
          <div className={`approval-actions${!approval && (request.options?.length ?? 0) > 3 ? " is-list" : ""}`}>
            <button type="button" className="btn btn-ghost btn-danger-text" onClick={onStop} disabled={stopping}>
              <IconStop size={12} /> {stopping ? "Stopping…" : "Stop"}
            </button>
            <span className="approval-spacer" />
            {approval ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => onAnswer(request, request.kind === "confirm" ? { kind: "confirm", confirmed: false } : { kind: "select", value: denyValue })}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  autoFocus
                  onClick={() => onAnswer(request, request.kind === "confirm" ? { kind: "confirm", confirmed: true } : { kind: "select", value: approveValue })}
                >
                  Approve
                </button>
              </>
            ) : (
              <>
                {(request.options ?? []).map((option, i) => (
                  <button
                    key={`${i}:${option}`}
                    type="button"
                    className={`btn${i === 0 ? " btn-primary" : ""}`}
                    disabled={busy}
                    onClick={() => onAnswer(request, { kind: "select", value: option })}
                  >
                    {option}
                  </button>
                ))}
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onAnswer(request, { kind: "cancel" })}>
                  Dismiss
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
