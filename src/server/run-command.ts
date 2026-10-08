// "Run" on a shell code block in an answer (T3 Code's): one command line, run
// in the chat's project folder by the shell its fence names, with a time
// limit and a cap on what is kept of the output. Any signed-in device may do
// this, as it may already ask the agent to.
import { spawn } from "node:child_process";
import type { RunShell, RunResult } from "../shared/protocol.js";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 100_000;

const SHELLS: Record<RunShell, string> = { bash: "bash", sh: "sh", zsh: "zsh", fish: "fish" };

export function runCommand(command: string, shell: RunShell, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let truncated = false;
    let timedOut = false;
    const take = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    const child = spawn(SHELLS[shell], ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    }, TIMEOUT_MS);
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `${shell}: ${error.message}`, truncated: false, timedOut: false, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, truncated, timedOut, durationMs: Date.now() - started });
    });
  });
}
