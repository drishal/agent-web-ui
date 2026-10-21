// A run that stopped on a usage limit (T3 Code's recovery banner), above the
// composer: when the limit resets, and a choice to send "continue" then, or
// now. The scheduled continue lives in this browser (a timer and storage), so
// it fires only while a tab of the chat is open; the banner says so.
import { useEffect, useState } from "react";
import { IconGauge, IconX } from "../icons.js";
import type { LimitStop } from "../limit-stop.js";
import { resetsIn } from "../limits.js";
import { useNow } from "../hooks.js";
import { load, save } from "../storage.js";
import { Dot } from "./Dot.js";

/** A little after the reset, so the first request does not race it. */
const AFTER_RESET_MS = 20_000;
/** setTimeout's ceiling; a longer wait re-arms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function LimitRecovery({ chatId, stop, idle, onContinue }: { chatId: string; stop: LimitStop; idle: boolean; onContinue: () => void }) {
  const key = `recover.${chatId}`;
  const [scheduled, setScheduled] = useState<{ id: string; at: number } | null>(() => load<{ id: string; at: number } | null>(key, null));
  const [dismissed, setDismissed] = useState(() => load<string | null>(`${key}.dismissed`, null) === stop.id);
  const now = useNow(true, 30_000);
  const mine = scheduled?.id === stop.id ? scheduled : null;

  const schedule = (next: { id: string; at: number } | null) => {
    setScheduled(next);
    save(key, next);
  };

  useEffect(() => {
    if (!mine) return;
    const timer = window.setTimeout(() => {
      if (Date.now() < mine.at) return;
      schedule(null);
      if (idle) onContinue();
    }, Math.min(MAX_TIMER_MS, Math.max(0, mine.at - Date.now())));
    return () => window.clearTimeout(timer);
  }, [mine?.at, now, idle]);

  if (dismissed) return null;
  const when = stop.resetsAt === null ? null : new Date(stop.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="limit-recovery" role="status" data-testid="limit-recovery">
      <span className="limit-recovery-icon">
        <IconGauge size={15} />
      </span>
      <span className="limit-recovery-text">
        <strong>Usage limit reached</strong>
        <span className="muted">
          <Dot />
          {mine ? `continues at ${when} — keep this tab open` : when ? `resets ${when} (${resetsIn(stop.resetsAt, now) ?? "soon"})` : "reset time unknown"}
        </span>
      </span>
      {stop.resetsAt !== null ? (
        mine ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => schedule(null)}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => schedule({ id: stop.id, at: (stop.resetsAt as number) + AFTER_RESET_MS })}>
            Continue when it resets
          </button>
        )
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
          schedule(null);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}
