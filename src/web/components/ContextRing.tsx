// Context occupancy ring (DeepSeek Harness / OpenCode). Its popover holds the
// whole picture, in DeepSeek Harness's sections: what fills the context
// window, the session's tokens, and model timing. Hidden until the harness
// reports a percentage.
import { useRef, useState } from "react";
import type { ContextCategory, ContextUsage, SessionUsage } from "../../shared/protocol.js";
import { useDismiss } from "../hooks.js";

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

const full = (n: number) => n.toLocaleString("en-US");

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Category colours: the system prompt grey, tools purple, messages blue (DeepSeek Harness), the rest after. */
const SWATCH: Record<string, string> = {
  system: "var(--muted)",
  "system-prompt": "var(--muted)",
  tools: "var(--thinking)",
  "system-tools": "var(--thinking)",
  messages: "var(--link)",
  skills: "var(--ok)",
  "system-context": "var(--warn)",
};
const FALLBACK = ["var(--accent)", "var(--danger)", "var(--text-2)"];
const swatch = (c: ContextCategory, i: number) => SWATCH[c.id] ?? FALLBACK[i % FALLBACK.length];

function Row({ label, value, color, title }: { label: string; value: string; color?: string | undefined; title?: string }) {
  return (
    <div className="usage-row" title={title}>
      <span className="usage-label">
        {color ? <span className="usage-swatch" style={{ background: color }} aria-hidden="true" /> : null}
        {label}
      </span>
      <span className="usage-value">{value}</span>
    </div>
  );
}

export function ContextRing({ context, usage }: { context: ContextUsage | null; usage: SessionUsage | null }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useDismiss(wrap, open, () => setOpen(false), { escape: true });

  // Hidden until there is real usage: an empty ring reads like a spinner.
  if (!context || context.percent === null || context.percent < 0.5) return null;
  const pct = Math.max(0, Math.min(100, context.percent));
  const r = 6;
  const c = 2 * Math.PI * r;
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
  const detail = `${Math.round(pct)}% of context used${context.tokens !== null ? ` · ${compact(context.tokens)} / ${compact(context.window)} tokens` : ""}`;
  const categories = context.categories?.filter((x) => x.tokens > 0) ?? [];

  const uncached = usage ? usage.input + usage.cacheWrite : 0;
  const inputTotal = usage ? uncached + usage.cachedInput : 0;
  const cacheHit = inputTotal > 0 && usage ? `${Math.round((usage.cachedInput / inputTotal) * 100)}%` : "—";
  const timed = usage !== null && (usage.llmMs !== null || usage.tokensPerSecond !== null);
  // A fresh session has nothing to report but zeros; show those sections after its first model call.
  const used = usage !== null && usage.steps > 0 ? usage : null;

  return (
    <div className="context-ring-wrap" ref={wrap}>
      <button
        type="button"
        className={`context-ring tone-${tone}`}
        aria-label={detail}
        aria-expanded={open}
        aria-haspopup="dialog"
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
        <div className="usage-pop" role="dialog" aria-label="Context and usage" data-testid="usage-panel">
          <section className="usage-section" aria-label="Context">
            <div className="usage-head">
              <span>
                <strong>{pct < 1 ? "<1" : Math.round(pct)}%</strong> of context used
              </span>
              <span className="usage-value">
                {context.tokens !== null ? `${compact(context.tokens)} / ${compact(context.window)}` : compact(context.window)}
              </span>
            </div>
            <div className="usage-bar" aria-hidden="true">
              {categories.length > 0 ? (
                categories.map((x, i) => (
                  <span key={x.id} style={{ width: `${(x.tokens / context.window) * 100}%`, background: swatch(x, i) }} />
                ))
              ) : (
                <span style={{ width: `${pct}%`, background: "currentColor" }} />
              )}
            </div>
            {categories.map((x, i) => (
              <Row key={x.id} label={x.label} value={compact(x.tokens)} color={swatch(x, i)} title={`${full(x.tokens)} tokens (estimated)`} />
            ))}
          </section>

          {used ? (
            <section className="usage-section" aria-label="Tokens">
              <div className="usage-head">
                <span>Tokens this session</span>
                <span className="usage-value">{full(inputTotal + used.output)}</span>
              </div>
              <Row label="Cache hit" value={cacheHit} />
              <Row label="Uncached input" value={full(uncached)} />
              <Row label="Cached input" value={full(used.cachedInput)} />
              <Row label="Output" value={full(used.output)} />
              {used.cost !== null ? <Row label="Cost" value={`$${used.cost.toFixed(used.cost < 1 ? 4 : 2)}`} /> : null}
            </section>
          ) : null}

          {used ? (
            <section className="usage-section" aria-label="Session">
              <div className="usage-head">
                <span>Session</span>
                <span className="usage-value">
                  {used.turns} {used.turns === 1 ? "turn" : "turns"} · {used.steps} {used.steps === 1 ? "step" : "steps"}
                </span>
              </div>
              <Row label="LLM time" value={used.llmMs !== null ? duration(used.llmMs) : "—"} />
              <Row label="Avg time to first token" value={used.ttftMs !== null ? duration(used.ttftMs) : "—"} />
              <Row label="Tokens per second" value={used.tokensPerSecond !== null ? `${used.tokensPerSecond} tok/s` : "—"} />
              {!timed ? <p className="usage-note">Timing is measured from runs this server watches.</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
