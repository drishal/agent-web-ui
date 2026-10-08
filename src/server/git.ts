// Running git for the server (checkpoints, the composer's git status): with
// none of the environment's GIT_* pointing it elsewhere, no prompts, no hooks
// or fsmonitor, and no automatic gc.
import { execFile } from "node:child_process";

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** `okExit`: exit codes that are an answer, not a failure (`diff --no-index` exits 1 when files differ). */
export function git(args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; okExit?: number[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...args],
      { cwd: opts.cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (!error || (typeof code === "number" && opts.okExit?.includes(code))) resolve(stdout);
        else reject(new Error(stderr.trim() || error.message));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
