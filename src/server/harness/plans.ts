// Proposed plans: the tool calls a harness makes to hand a plan over for review
// (Claude Code's ExitPlanMode, pi-plan-mode's plan_mode_complete), so the web
// UI can show the plan as a card rather than a tool row with JSON arguments.
// The plan comes from the call's own `plan` argument, kept apart from the
// arguments' 4 KB cut and bounded by itself.

/** Tool names that hand over a plan; their `plan` argument is Markdown. */
const PLAN_TOOLS = new Set(["exitplanmode", "exit_plan_mode", "plan_mode_complete"]);
export const MAX_PLAN_CHARS = 32_000;

/** The plan a call proposes, or null when it is not a plan call. */
export function planFromArgs(name: string, args: unknown): string | null {
  if (!PLAN_TOOLS.has(name.toLowerCase())) return null;
  const plan = args && typeof args === "object" ? (args as { plan?: unknown }).plan : undefined;
  if (typeof plan !== "string" || !plan.trim()) return null;
  const text = plan.trim();
  return text.length > MAX_PLAN_CHARS ? `${text.slice(0, MAX_PLAN_CHARS)}\n\n…` : text;
}
