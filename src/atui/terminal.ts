// What atui tells the terminal itself, besides drawing the screen: the window
// (or tab) title, and the progress indicator that Ghostty, Windows Terminal,
// and ConEmu draw in the tab or taskbar (OSC 9;4). The title names the chat
// and counts the sessions that need you, as the web UI's page title does; the
// progress spins while the shown chat works and is a paused (amber) bar while
// a session asks for you. Pure, so it can be tested; main.tsx writes it.

export type Progress = "busy" | "asking" | null;

export interface TerminalState {
  title: string;
  progress: Progress;
}

/** The title and progress for the shown chat's `title`, whether it works, and how many sessions ask for you. */
export function terminalState(o: { title: string; busy: boolean; asking: number }): TerminalState {
  // The title is the agent's text: no control character may end the sequence early.
  const name = o.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 120);
  const count = o.asking > 0 ? `(${o.asking > 99 ? "99+" : o.asking}) ` : "";
  return { title: `${count}${o.busy ? "● " : ""}${name} · atui`, progress: o.asking > 0 ? "asking" : o.busy ? "busy" : null };
}

/**
 * Whether the terminal draws OSC 9;4. Elsewhere OSC 9 is a desktop
 * notification (kitty, iTerm2), so the progress would pop up as one; tmux
 * passes neither on. $ATUI_PROGRESS=1 or 0 decides instead.
 */
export function speaksProgress(env: Record<string, string | undefined>): boolean {
  if (env.ATUI_PROGRESS === "1" || env.ATUI_PROGRESS === "0") return env.ATUI_PROGRESS === "1";
  if (env.TMUX) return false;
  return /ghostty/i.test(env.TERM_PROGRAM ?? "") || Boolean(env.WT_SESSION) || env.ConEmuANSI === "ON";
}

/** OSC 9;4: 3 spins (no known end), 4 at 100 is a paused bar, 0 takes it away. */
export function progressSequence(progress: Progress): string {
  return `\x1b]9;4;${progress === "busy" ? "3" : progress === "asking" ? "4;100" : "0"}\x1b\\`;
}
