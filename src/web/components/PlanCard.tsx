// A plan the agent handed over for review (T3 Code's proposed-plan card):
// Claude Code's ExitPlanMode or pi-plan-mode's plan_mode_complete, drawn as
// Markdown instead of a tool row's JSON. A long plan shows its first lines
// until opened. On the latest turn, with the agent idle and nothing asked of
// you, Implement sends "go ahead" and Revise starts a message about it; while
// the harness itself asks (Claude's plan approval, pi-plan-mode's review
// menu), its question above the composer is the way to answer instead.
import { useState } from "react";
import { addToDraft } from "../draft-bus.js";
import { IconPlan } from "../icons.js";
import { Markdown } from "./Markdown.js";

/** Lines shown before "Show the whole plan". */
const PREVIEW_LINES = 8;
export const IMPLEMENT_TEXT = "Implement the plan.";

export function PlanCard({ plan, onImplement }: { plan: string; onImplement: (() => void) | null }) {
  const lines = plan.split("\n");
  const long = lines.filter((l) => l.trim()).length > PREVIEW_LINES;
  const [open, setOpen] = useState(!long);
  return (
    <section className={`plan-card${open ? " is-open" : ""}`} aria-label="Proposed plan" data-testid="plan-card">
      <header className="plan-card-head">
        <IconPlan size={14} />
        <span>Plan</span>
      </header>
      <div className="plan-card-body">
        <Markdown text={plan} />
      </div>
      <footer className="plan-card-foot">
        {long ? (
          <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Show less" : "Show the whole plan"}
          </button>
        ) : null}
        {onImplement ? (
          <span className="plan-card-actions">
            <button type="button" className="btn btn-small" onClick={() => addToDraft("About the plan: ")}>
              Revise
            </button>
            <button type="button" className="btn btn-small btn-primary" onClick={onImplement}>
              Implement
            </button>
          </span>
        ) : null}
      </footer>
    </section>
  );
}
