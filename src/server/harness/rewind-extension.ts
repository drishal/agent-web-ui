// The /rewind-to extension (extensions/rewind-to.ts) that the Pi and omp
// children load with -e: it moves a session back to just before an earlier
// prompt in place, which neither can do over RPC (their fork and branch start
// a new session). Edit and Retry run `/rewind-to <n>`, check the session went
// back, then send the new prompt.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatItem } from "../../shared/protocol.js";

export const REWIND_COMMAND = "rewind-to";

let found: string | null | undefined;

/** The extension file, found by walking up from here (src/ in development, dist/ when built). */
export function rewindExtension(): string | null {
  if (found !== undefined) return found;
  found = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", "rewind-to.ts");
    if (existsSync(file)) return (found = file);
    if (path.dirname(dir) === dir) return found;
  }
}

/** The CLI arguments that load it, or none when it is missing. */
export function rewindExtensionArgs(): string[] {
  const file = rewindExtension();
  return file ? ["-e", file] : [];
}

export const userPrompts = (items: ChatItem[]): number => items.filter((i) => i.kind === "user" && !i.command).length;

/**
 * Rewind through /rewind-to: refuse when the extension is not loaded (the
 * text would otherwise reach the model as a prompt), run it, and check the
 * session now holds exactly the prompts before `turn`.
 */
export async function rewindWithExtension(
  harness: string,
  turn: number,
  live: { commandNames(): Promise<string[]>; runCommand(text: string): Promise<boolean>; history(): Promise<ChatItem[]> },
): Promise<void> {
  if (!(await live.commandNames()).includes(REWIND_COMMAND)) {
    throw new Error(`${harness} has not loaded the ${REWIND_COMMAND} extension (extensions/rewind-to.ts)`);
  }
  const before = userPrompts(await live.history());
  if (turn > before) throw new Error("That message is no longer in the session");
  if (!(await live.runCommand(`/${REWIND_COMMAND} ${turn}`))) throw new Error(`${harness} did not run /${REWIND_COMMAND}`);
  // The answer can come before the move has settled: look again for a moment.
  let after = userPrompts(await live.history());
  for (let i = 0; i < 20 && after !== turn - 1; i++) {
    await new Promise((r) => setTimeout(r, 100));
    after = userPrompts(await live.history());
  }
  if (after !== turn - 1) throw new Error(`${harness} did not go back to before message ${turn} (it still holds ${after} prompts)`);
}
