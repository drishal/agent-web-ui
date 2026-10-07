// The sidebar's footer: how much of each subscription's rate limits is used
// (Claude Code's five-hour and weekly windows, every account omp is signed in
// to). Folded, one line with the fullest window; open, a bar per window with
// when it resets.
import { useState } from "react";
import type { UsageLimits } from "../../shared/protocol.js";
import { IconChevronDown } from "../icons.js";
import { accountName, level, percent, resetsIn, tightest } from "../limits.js";
import { load, save } from "../storage.js";

export function LimitsMeter({ limits }: { limits: UsageLimits | null }) {
  const [open, setOpen] = useState(() => load<boolean>("limitsOpen", false));
  if (!limits || (limits.accounts.length === 0 && limits.errors.length === 0)) return null;
  const top = tightest(limits.accounts);
  const anyLimited = limits.accounts.some((a) => a.limited);
  const toggle = () => {
    setOpen(!open);
    save("limitsOpen", !open);
  };
  return (
    <section className={`limits${open ? " is-open" : ""}`} aria-label="Usage limits">
      <button type="button" className="limits-head" aria-expanded={open} onClick={toggle}>
        <span className="limits-title">Usage limits</span>
        {top ? (
          <span className={`limits-top is-${level(top.window.used, anyLimited)}`}>
            {anyLimited ? "Limited" : `${accountName(top.account)} ${top.window.label} · ${percent(top.window.used)}`}
          </span>
        ) : null}
        <IconChevronDown size={12} className="limits-chevron" />
      </button>
      {open ? (
        <div className="limits-body">
          {limits.accounts.map((a) => (
            <div key={a.id} className="limits-account" title={`From ${a.source}, ${new Date(a.at).toLocaleString()}`}>
              <div className="limits-name">
                {accountName(a)}
                {a.plan ? <span className="limits-plan">{a.plan}</span> : null}
                {a.limited ? <span className="limits-plan is-full">limited</span> : null}
              </div>
              {a.windows.map((w) => (
                <div key={w.label} className="limits-window">
                  <span className="limits-label">{w.label}</span>
                  <span className="limits-bar" role="meter" aria-label={`${accountName(a)} ${w.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.used === null ? undefined : Math.round(w.used * 100)}>
                    <span className={`limits-fill is-${level(w.used)}`} style={{ width: `${Math.round((w.used ?? 0) * 100)}%` }} />
                  </span>
                  <span className="limits-pct">{percent(w.used)}</span>
                  {w.resetsAt ? <span className="limits-reset">resets {resetsIn(w.resetsAt)}</span> : null}
                </div>
              ))}
            </div>
          ))}
          {limits.errors.map((e) => (
            <p key={e} className="sidebar-note is-warning">
              {e}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
