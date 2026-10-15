// `awui tern`'s command line: atui's options, less the ones about drawing on
// a grid (Tern draws, so there is no vim mode or image protocol to pick).

export interface TernArgs {
  cwd: string;
  url: string;
  harness?: string;
  chatId?: string;
  resume?: string | true;
  version: string;
}

export const TERN_USAGE = `awui tern: awui drawn natively in a Tern pane

Usage: awui tern [options]

  --url <url>         the awui server (default $AWUI_URL or http://127.0.0.1:4783)
  --harness <id>      the harness for new chats (pi, omp, hermes, claude, …)
  --resume [id]       resume a session: the given one, or this project's newest
  --chat <id>         attach to a chat that is open on the server
  -h, --help          this help

Starts in the current folder's project. Enter sends, Shift+Enter adds a line,
C-k lists commands, C-x then a letter for the rest (C-x alone shows them),
Esc Esc stops the agent, C-c C-c quits (the chat keeps running on the
server, to come back to with --chat or from the sessions).`;

export function parseTernArgs(argv: string[], env: Record<string, string | undefined>): TernArgs | { help: true } | { error: string } {
  const out: TernArgs = { cwd: process.cwd(), url: env.AWUI_URL || "http://127.0.0.1:4783", version: env.AWUI_VERSION || "dev" };
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
    else return { error: `Unknown option ${arg}` };
  }
  out.url = out.url.replace(/\/+$/, "");
  return out;
}
