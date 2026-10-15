// Usage across sessions: what the chats spent in the last 7, 30, or 90 days,
// from the server's report (usage-report.ts, read from the harnesses' own
// files): the totals as cards, a bar a day split by harness in its colour, the
// harnesses and models side by side, and the chats that used the most (a
// click opens one). Days are the browser's.
import { useEffect, useMemo, useState } from "react";
import type { HarnessStatus, ProjectSession, UsageReport, UsageTotals, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { harnessColor } from "../harness-colors.js";
import { Spinner } from "../icons.js";
import { ago } from "../turns.js";
import { cacheShare, dayBars, dayLabels, dollars, shortTokens, tokensOf } from "../usage.js";
import { Dialog } from "./Dialog.js";

const RANGES = [7, 30, 90] as const;

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`usage-card${tone ? ` is-${tone}` : ""}`}>
      <span className="usage-card-label">{label}</span>
      <span className="usage-card-value">{value}</span>
      {sub ? <span className="usage-card-sub">{sub}</span> : null}
    </div>
  );
}

/** A row with a bar: its share of the largest in its list. */
function BarRow({ label, share, value, detail, style }: { label: React.ReactNode; share: number; value: string; detail?: string; style?: React.CSSProperties }) {
  return (
    <div className="usage-row" style={style}>
      <span className="usage-row-label">{label}</span>
      <span className="usage-row-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
      </span>
      <span className="usage-row-value">{value}</span>
      {detail !== undefined ? <span className="usage-row-detail">{detail}</span> : null}
    </div>
  );
}

const cost = (t: UsageTotals) => dollars(t.cost, t.calls > t.unpriced);

export function UsageDialog({ harnesses, onOpenSession, onClose }: { harnesses: HarnessStatus[]; onOpenSession: (s: ProjectSession, ws: WorkspaceInfo | undefined) => void; onClose: () => void }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    setBusy(true);
    api<UsageReport>(`/api/usage?days=${days}&tz=${new Date().getTimezoneOffset()}`).then(
      (r) => {
        if (!live) return;
        setReport(r);
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(errorText(e));
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
  }, [days]);

  const name = (id: string) => harnesses.find((h) => h.id === id)?.displayName ?? id;
  const bars = useMemo(() => (report ? dayBars(report) : []), [report]);
  const labels = useMemo(() => dayLabels(bars.map((b) => b.day), days <= 7 ? 1 : days <= 30 ? 5 : 15), [bars, days]);
  const t = report?.totals;
  const share = t ? cacheShare(t) : null;
  const most = (list: Array<{ totals: UsageTotals }>) => Math.max(1, ...list.map((x) => tokensOf(x.totals)));
  const project = (id: string) => report?.workspaces.find((w) => w.id === id);

  return (
    <Dialog title="Usage" onClose={onClose} className="usage-dialog">
      <div className="usage-top">
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((n) => (
            <button key={n} type="button" className={n === days ? "is-on" : undefined} aria-pressed={n === days} onClick={() => setDays(n)}>
              {n} days
            </button>
          ))}
        </div>
        {busy ? (
          <span className="usage-busy muted">
            <Spinner size={12} /> Reading sessions…
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="usage-error" role="alert">
          {error}
        </p>
      ) : null}
      {report && t ? (
        <div className={`usage-body${busy ? " is-stale" : ""}`}>
          <div className="usage-cards">
            <Card label="Tokens" value={shortTokens(tokensOf(t))} sub={`${t.calls.toLocaleString()} model ${t.calls === 1 ? "call" : "calls"}`} tone="accent" />
            <Card label="Output" value={shortTokens(t.output)} sub={`${shortTokens(t.input)} fresh input`} />
            <Card label="From cache" value={share === null ? "—" : `${Math.round(share * 100)}%`} sub={`${shortTokens(t.cachedInput)} input tokens`} tone="ok" />
            <Card label="Cost" value={cost(t)} sub={t.unpriced > 0 ? `${t.unpriced.toLocaleString()} ${t.unpriced === 1 ? "call" : "calls"} not priced` : "every call priced"} tone="warn" />
            <Card label="Chats" value={t.sessions.toLocaleString()} sub={`with calls in ${days} days`} />
          </div>

          <section className="usage-chart" aria-label="Tokens by day">
            <div className="usage-bars">
              {bars.map((b, i) => (
                <div key={b.day} className="usage-day" title={`${b.day}: ${shortTokens(b.total)} tokens${b.segments.length > 1 ? ` (${b.segments.map((s) => `${name(s.harnessId)} ${shortTokens(s.tokens)}`).join(", ")})` : ""}`}>
                  <div className="usage-stack">
                    {b.segments.map((s) => (
                      <span key={s.harnessId} className="usage-seg" style={{ ...harnessColor(s.harnessId), height: `${s.share * 100}%` }} />
                    ))}
                  </div>
                  <span className="usage-day-label">{labels[i] ?? ""}</span>
                </div>
              ))}
            </div>
            <div className="usage-legend">
              {report.byHarness.map((h) => (
                <span key={h.harnessId} className="usage-legend-item" style={harnessColor(h.harnessId)}>
                  <span className="usage-legend-dot" aria-hidden="true" />
                  {name(h.harnessId)}
                </span>
              ))}
            </div>
          </section>

          <div className="usage-split">
            <section aria-label="By harness">
              <h3>By harness</h3>
              {report.byHarness.length === 0 ? <p className="muted usage-none">No calls in this range</p> : null}
              {report.byHarness.map((h) => (
                <BarRow
                  key={h.harnessId}
                  style={harnessColor(h.harnessId)}
                  label={<span className="badge badge-harness">{name(h.harnessId)}</span>}
                  share={tokensOf(h.totals) / most(report.byHarness)}
                  value={shortTokens(tokensOf(h.totals))}
                  detail={cost(h.totals)}
                />
              ))}
            </section>
            <section aria-label="By model">
              <h3>By model</h3>
              {report.byModel.length === 0 ? <p className="muted usage-none">No calls in this range</p> : null}
              {report.byModel.map((m) => (
                <BarRow
                  key={`${m.harnessId}:${m.model}`}
                  style={harnessColor(m.harnessId)}
                  label={
                    <span className="usage-model" title={`${m.model} (${name(m.harnessId)})`}>
                      {m.model.split("/").pop()}
                    </span>
                  }
                  share={tokensOf(m.totals) / most(report.byModel)}
                  value={shortTokens(tokensOf(m.totals))}
                  detail={cost(m.totals)}
                />
              ))}
            </section>
          </div>

          {report.top.length > 0 ? (
            <section className="usage-top-chats" aria-label="Chats that used the most">
              <h3>Chats that used the most</h3>
              <ul>
                {report.top.map(({ session, totals }) => (
                  <li key={session.id} style={harnessColor(session.harnessId)}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenSession(session, project(session.workspaceId));
                        onClose();
                      }}
                    >
                      <span className="usage-chat-title">{session.title || "New chat"}</span>
                      <span className="usage-chat-meta">
                        <span className="badge badge-harness">{name(session.harnessId)}</span>
                        {[project(session.workspaceId)?.name, session.updatedAt ? ago(Date.parse(session.updatedAt)) : null].filter(Boolean).join(" · ")}
                      </span>
                      <span className="usage-chat-tokens">{shortTokens(tokensOf(totals))}</span>
                      <span className="usage-chat-cost">{cost(totals)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="usage-foot muted">
            Read from the harnesses' own session files, never by starting one.
            {report.unreadable.length > 0 ? ` ${report.unreadable.join(", ")} ${report.unreadable.length === 1 ? "keeps" : "keep"} sessions in a database of its own, so ${report.unreadable.length === 1 ? "its" : "their"} calls are not counted.` : ""}
            {report.truncated ? ` Stopped after ${report.scanned} of ${report.total} chats to stay quick.` : ""}
          </p>
        </div>
      ) : !error ? (
        <p className="usage-loading muted">
          <Spinner size={13} /> Reading sessions…
        </p>
      ) : null}
    </Dialog>
  );
}
