// A run that stopped on a usage limit (T3 Code's recovery banner), above the
// composer: when the limit resets, and a choice to send "continue" then, or now.
// The scheduled continue lives in the server (chat.scheduleContinue), so it fires
// with every browser closed, and every device sees the same appointment.
import { useState } from "react";
import { IconGauge, IconX } from "../icons.js";
import type { LimitStop } from "../../shared/limit-stop.js";
import { resetsIn } from "../limits.js";
import { useNow } from "../hooks.js";
import { load, save } from "../storage.js";
import { Dot } from "./Dot.js";

/** A little after the reset, so the first request does not race it. */
const AFTER_RESET_MS = 20_000;

export function LimitRecovery({
  chatId,
  stop,
  idle,
  continueAt,
  onContinue,
  onSchedule,
}: {
  chatId: string;
  stop: LimitStop;
  idle: boolean;
  /** The server's appointment for this chat, if any (chat.scheduleContinue). */
  continueAt: number | null;
  onContinue: () => void;
  onSchedule: (at: number | null) => Promise<void>;
}) {
  const key = `recover.${chatId}`;
  const [dismissed, setDismissed] = useState(() => load<string | null>(`${key}.dismissed`, null) === stop.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(true, 30_000);

  const schedule = async (at: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSchedule(at);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (dismissed) return null;
  const at = continueAt ?? stop.resetsAt;
  const when = at === null ? null : new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="limit-recovery" role="status" data-testid="limit-recovery">
      <span className="limit-recovery-icon">
        <IconGauge size={15} />
      </span>
      <span className="limit-recovery-text">
        <strong>Usage limit reached</strong>
        <span className="muted">
          <Dot />
          {continueAt !== null
            ? `continues at ${when} — no tab has to stay open`
            : when
              ? `resets ${when} (${resetsIn(stop.resetsAt as number, now) ?? "soon"})`
              : "reset time unknown"}
          {error ? ` · ${error}` : null}
        </span>
      </span>
      {continueAt !== null ? (
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void schedule(null)}>
          Cancel
        </button>
      ) : stop.resetsAt !== null ? (
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void schedule((stop.resetsAt as number) + AFTER_RESET_MS)}>
          Continue when it resets
        </button>
      ) : null}
      <button type="button" className="btn btn-small btn-ghost" disabled={!idle} onClick={onContinue}>
        Continue now
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
          save(`${key}.dismissed`, stop.id);
          if (continueAt !== null) void schedule(null);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}
