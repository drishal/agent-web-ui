// atui's command line.
import type { AtuiOptions } from "./state.js";

export const USAGE = `atui: awui in the terminal

Usage: atui [options]

  --url <url>         the awui server (default $AWUI_URL or http://127.0.0.1:4783)
  --harness <id>      the harness for new chats (pi, omp, hermes, claude, …)
  --resume [id]       resume a session: the given one, or this project's newest
  --chat <id>         attach to a chat that is open on the server
  --vim, --no-vim     vim navigation: Esc for NORMAL (j/k, gg/G, {/}, :), i to type
                      (default: as last set with Ctrl+X V, or $ATUI_VIM=1)
  -h, --help          this help

Starts in the current folder's project. Keys: Ctrl+K commands, Ctrl+X then a
letter for the rest (Ctrl+X alone lists them), Enter sends, Shift+Enter or
Ctrl+J adds a line, Esc Esc stops the agent, Ctrl+C twice quits.`;

export function parseArgs(argv: string[], env: Record<string, string | undefined>): (AtuiOptions & { url: string }) | { help: true } | { error: string } {
  const out: AtuiOptions & { url: string } = { cwd: process.cwd(), url: env.AWUI_URL || "http://127.0.0.1:4783" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return null;
      i += 1;
      return next;
    };
    if (arg === "-h" || arg === "--help") return { help: true };
    else if (arg === "--url") {
      const v = value();
      if (!v) return { error: "--url needs a value" };
      out.url = v;
    } else if (arg === "--harness") {
      const v = value();
      if (!v) return { error: "--harness needs a value" };
      out.harness = v;
    } else if (arg === "--chat") {
      const v = value();
      if (!v) return { error: "--chat needs a value" };
      out.chatId = v;
    } else if (arg === "--resume") out.resume = value() ?? true;
    else if (arg === "--vim") out.vim = true;
    else if (arg === "--no-vim") out.vim = false;
    else return { error: `Unknown option ${arg}` };
  }
  out.url = out.url.replace(/\/+$/, "");
  return out;
}
