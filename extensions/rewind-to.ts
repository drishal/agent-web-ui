// /rewind-to: go back to just before an earlier prompt of this session, in
// place, as Pi's /tree does when you pick a user message. The session keeps
// what followed as a side branch (reachable from /tree); the next prompt you
// send continues from the earlier point.
//
//   /rewind-to        pick the prompt from a list (the prompt lands in the editor)
//   /rewind-to <n>    the nth prompt of the current branch, 1 being the first
//
// awui's Edit and Retry send `/rewind-to <n>` over RPC, then the new
// prompt. Works in Pi and in oh-my-pi (omp): it uses only the extension API
// both share, and imports nothing.

interface Entry {
  id: string;
  type: string;
  message?: { role?: string; content?: unknown };
}

interface Ctx {
  hasUI: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    setEditorText(text: string): void;
  };
  sessionManager: { getBranch(): Entry[] };
  waitForIdle(): Promise<void>;
  navigateTree?(entryId: string): Promise<{ cancelled: boolean }>;
}

interface Api {
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
}

// Loaded twice (from the extensions folder and again with -e), it registers once.
const LOADED = Symbol.for("rewind-to.loaded");

function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("");
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export default function rewindTo(pi: Api): void {
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[LOADED]) return;
  registry[LOADED] = true;

  pi.registerCommand("rewind-to", {
    description: "Go back to just before an earlier prompt of this session (in place): /rewind-to [n]",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const prompts = ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message?.role === "user");
      if (prompts.length === 0) {
        ctx.ui.notify("rewind-to: there is no earlier prompt", "warning");
        return;
      }
      if (typeof ctx.navigateTree !== "function") {
        ctx.ui.notify("rewind-to: this host cannot move within a session", "error");
        return;
      }
      const asked = args.trim();
      let target: Entry | undefined;
      if (asked) {
        const n = Number(asked);
        target = Number.isInteger(n) ? prompts[n - 1] : undefined;
        if (!target) {
          ctx.ui.notify(`rewind-to: give a prompt number from 1 to ${prompts.length}`, "error");
          return;
        }
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify(`rewind-to: give a prompt number from 1 to ${prompts.length}`, "error");
          return;
        }
        const labels = prompts.map((p, i) => `${i + 1}. ${oneLine(promptText(p.message?.content)).slice(0, 90)}`);
        const picked = await ctx.ui.select("Go back to just before which prompt?", labels);
        if (picked === undefined) return;
        target = prompts[labels.indexOf(picked)];
        if (!target) return;
      }
      const result = await ctx.navigateTree(target.id);
      if (result.cancelled) {
        ctx.ui.notify("rewind-to: cancelled", "warning");
        return;
      }
      // Picked by hand: the prompt comes back to be edited and sent again.
      if (!asked && ctx.hasUI) ctx.ui.setEditorText(promptText(target.message?.content));
    },
  });
}
