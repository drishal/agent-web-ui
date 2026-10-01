// Context occupancy ring (DeepSeek Harness / OpenCode). Hidden until the
// harness reports a percentage.
import { useState } from "react";
import type { ContextUsage } from "../../shared/protocol.js";

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function ContextRing({ context }: { context: ContextUsage | null }) {
  const [open, setOpen] = useState(false);
  // Hidden until there is real usage: an empty ring reads like a spinner.
  if (!context || context.percent === null || context.percent < 0.5) return null;
  const pct = Math.max(0, Math.min(100, context.percent));
  const r = 6;
  const c = 2 * Math.PI * r;
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
  const detail = `${Math.round(pct)}% of context used${context.tokens !== null ? ` · ${compact(context.tokens)} / ${compact(context.window)} tokens` : ""}`;
  return (
    <div className="context-ring-wrap">
      <button
        type="button"
        className={`context-ring tone-${tone}`}
        aria-label={detail}
        aria-expanded={open}
        data-testid="context-ring"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * c} ${c}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span className="context-pct">{Math.round(pct)}%</span>
      </button>
      {open ? (
        <div className="context-pop" role="status">
          {detail}
        </div>
      ) : null}
    </div>
  );
}
