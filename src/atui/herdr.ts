// atui in a herdr pane (herdr.dev, the terminal workspace manager for coding
// agents). Herdr knows Pi, Claude Code, and the rest through their own hooks,
// but awui's chats run behind the server, out of herdr's sight, so atui reports
// for them on the pane's API socket as those hooks do: working while a chat in
// its tabs runs, blocked while one asks, idle otherwise; the shown chat's title;
// and how to bring the session back after herdr restarts. Herdr drops the report
// once the pane is back at its shell prompt, so quitting needs no goodbye.
// paneReport and resumeArgv are pure; main.tsx feeds the reporter.
import { herdrRequest } from "../server/herdr.js";

/** The source atui reports as: herdr keeps one report per source, and the server skips its own (server/herdr.ts). */
const SOURCE = "awui:atui";
const AGENT = "awui";

export interface HerdrPaneEnv {
  socket: string;
  paneId: string;
}

/** The herdr pane atui runs in, as herdr's own hooks find it; null outside herdr. */
export function herdrPane(env: Record<string, string | undefined>): HerdrPaneEnv | null {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) return null;
  return { socket: env.HERDR_SOCKET_PATH, paneId: env.HERDR_PANE_ID };
}

export interface PaneReport {
  state: "working" | "blocked" | "idle";
  /** What blocks it, for herdr's badge. */
  message: string | null;
  title: string;
  /** `<harness>:<native id>`, once the harness has named the session. */
  sessionId: string | null;
  harness: string | null;
}

export interface ShownChat {
  status: string;
  pending: ReadonlyArray<{ title: string }>;
  title: string;
  sessionId: string | null;
  harnessId: string;
}

const RUNNING = new Set(["starting", "running", "stopping", "compacting"]);

/** What the pane reports: the shown chat, and how many chats in atui's other tabs work or ask. */
export function paneReport(chat: ShownChat | null, others: { busy: number; asking: number }): PaneReport {
  const ask = chat?.pending[0];
  const asking = (chat?.pending.length ? 1 : 0) + others.asking;
  const message = ask ? ask.title : asking > 0 ? (asking === 1 ? "A chat needs you" : `${asking} chats need you`) : null;
  const state = asking > 0 ? "blocked" : (chat && RUNNING.has(chat.status)) || others.busy > 0 ? "working" : "idle";
  // Herdr shows these in its sidebar: no control character may reach it.
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 120);
  return { state, message: message ? clean(message) : null, title: clean(chat?.title || "New chat"), sessionId: chat?.sessionId ?? null, harness: chat?.harnessId ?? null };
}

/** The command that opens `sessionId` again: atui by name (herdr wants a plain command), its server named when not the default. */
export function resumeArgv(command: string | null, url: string, defaultUrl: string, sessionId: string): string[] | null {
  if (!command) return null;
  return [command, ...(url === defaultUrl ? [] : ["--url", url]), "--resume", sessionId];
}

/**
 * Sends each new report to the pane, the newest winning: a report sent while
 * one is in flight replaces any still waiting. Herdr orders them by `seq`.
 */
export function createHerdrReporter(pane: HerdrPaneEnv, opts: { resume: (sessionId: string) => string[] | null; log?: (message: string) => void }) {
  let seq = Date.now() * 1000;
  let waiting: PaneReport | null = null;
  let sending = false;
  let last: PaneReport | null = null;
  const call = (method: string, params: Record<string, unknown>) => herdrRequest(pane.socket, method, { pane_id: pane.paneId, source: SOURCE, agent: AGENT, seq: ++seq, ...params });

  const send = async (r: PaneReport) => {
    const before = last;
    await call("pane.report_agent", { state: r.state, message: r.message });
    if (r.title !== before?.title || r.harness !== before?.harness) {
      await call("pane.report_metadata", { title: r.title, display_agent: r.harness ? `atui · ${r.harness}` : "atui" });
    }
    // The resume command needs the pane held first, which the state report just did.
    const argv = r.sessionId && r.sessionId !== before?.sessionId ? opts.resume(r.sessionId) : null;
    if (r.sessionId && argv) await call("pane.report_agent_session", { agent_session_id: r.sessionId, resume_argv: argv });
    last = r;
  };

  const drain = async () => {
    if (sending) return;
    sending = true;
    try {
      while (waiting) {
        const next = waiting;
        waiting = null;
        await send(next).catch((error: unknown) => opts.log?.(`herdr: ${error instanceof Error ? error.message : String(error)}`));
      }
    } finally {
      sending = false;
    }
  };

  return {
    report(r: PaneReport) {
      const same = last && !waiting && !sending && last.state === r.state && last.message === r.message && last.title === r.title && last.sessionId === r.sessionId && last.harness === r.harness;
      if (same) return;
      waiting = r;
      void drain();
    },
  };
}
