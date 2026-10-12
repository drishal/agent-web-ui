// atui's command line.
import { imageModeFrom } from "./images.js";
import type { AtuiOptions } from "./state.js";

export const USAGE = `atui: awui in the terminal

Usage: atui [options]

  --url <url>         the awui server (default $AWUI_URL or http://127.0.0.1:4783)
  --harness <id>      the harness for new chats (pi, omp, hermes, claude, …)
  --resume [id]       resume a session: the given one, or this project's newest
  --chat <id>         attach to a chat that is open on the server
  --vim, --no-vim     vim navigation: Esc for NORMAL (j/k, gg/G, {/}, :), i to type
                      (default: as last set with C-x v, or $ATUI_VIM=1)
  --images <mode>     how prompt images are drawn: auto (ask the terminal), kitty
                      (kitty, Ghostty), sixel, blocks, or off (default $ATUI_IMAGES, auto)
  -h, --help          this help

Starts in the current folder's project. Keys, in Emacs notation (C- is Ctrl,
M- is Alt): C-k commands, C-x then a letter for the rest (C-x lists them),
Enter sends, S-Enter or C-j adds a line, C-v pastes an image (or drop image
files on the terminal), Esc Esc stops the agent, C-c C-c quits.`;

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
    else if (arg === "--images") {
      const mode = imageModeFrom(value() ?? "", {});
      if (!mode) return { error: "--images takes auto, kitty, sixel, blocks, or off" };
      out.images = mode;
    } else if (arg === "--vim") out.vim = true;
    else if (arg === "--no-vim") out.vim = false;
    else return { error: `Unknown option ${arg}` };
  }
  out.url = out.url.replace(/\/+$/, "");
  return out;
}
