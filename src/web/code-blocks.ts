// Which code blocks in an answer can be run: one command line in a shell the server knows.
import { RUN_SHELLS, type RunShell } from "../shared/protocol.js";

const SHELL_OF: Record<string, RunShell> = { bash: "bash", sh: "sh", shell: "sh", shellscript: "sh", console: "sh", zsh: "zsh", fish: "fish" };

/** The shell to run a block with, or null when it is not a one-line shell block. */
export function runnable(lang: string | null, code: string): { shell: RunShell; command: string } | null {
  const shell = lang ? SHELL_OF[lang.toLowerCase()] : undefined;
  if (!shell || !(RUN_SHELLS as readonly string[]).includes(shell)) return null;
  const command = code.trim().replace(/^\$\s+/, "");
  if (!command || command.includes("\n")) return null;
  return { shell, command };
}
