// eval_python: run a short Python snippet and return its printed output, for
// the awui chat harness (loaded with -e). The awui surface is read-only on the
// project — no bash/edit/write — but a chat agent still needs to compute: a
// quick calculation, a table reshape, a matplotlib check. This tool is the
// governed way in: each call runs `python3` once on a temp script with a hard
// timeout and bounded stdout/stderr, no state kept between calls, and the
// script cwd is a scratch dir, not the workspace, so it cannot even read the
// project unless it is handed absolute paths.
//
// It activates only when the awui server spawned the child (AWUI_RENDER_URL
// present), so a stray copy elsewhere registers nothing.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
  isError?: boolean;
}

interface Api {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: { code: string; timeout?: number }, signal?: AbortSignal): Promise<ToolResult>;
  }): void;
}

// Loaded twice (from a project's extensions folder and again with -e), it registers once.
const LOADED = Symbol.for("awui-eval-python.loaded");

const MAX_CODE_CHARS = 32 * 1024;
const MAX_OUTPUT_CHARS = 16 * 1024;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;

const text = (value: string): ToolContent => ({ type: "text", text: value });

/** head…tail, so a runaway print keeps both the error and the start. */
function bound(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const head = s.slice(0, MAX_OUTPUT_CHARS / 2);
  const tail = s.slice(-MAX_OUTPUT_CHARS / 2);
  return `${head}\n… [${(s.length - MAX_OUTPUT_CHARS) | 0} chars omitted] …\n${tail}`;
}

export default function evalPython(pi: Api): void {
  if (!process.env.AWUI_RENDER_URL) return; // only the awui harness wires this
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[LOADED]) return;
  registry[LOADED] = true;

  pi.registerTool({
    name: "eval_python",
    label: "Run Python",
    description:
      "Run a short Python snippet and get its printed output (stdout, then stderr), for calculations, reshaping data, and quick checks. " +
      "Stateless: each call is a fresh `python3` process, so print results instead of keeping them in variables. " +
      `No network egress is expected from here; it reads and writes only a scratch directory, not the project. Timeout ${DEFAULT_TIMEOUT_S}s (max ${MAX_TIMEOUT_S}s).`,
    parameters: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string", description: `One or more statements; print() what should be seen. At most ${MAX_CODE_CHARS / 1024} KB.` },
        timeout: { type: "number", description: `Seconds before it is interrupted (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).` },
      },
    },
    async execute(_toolCallId, params, signal) {
      const code = typeof params.code === "string" ? params.code : "";
      if (code.trim() === "") return { content: [text("code is empty")], details: {}, isError: true };
      if (code.length > MAX_CODE_CHARS) return { content: [text(`code is ${code.length} chars; the limit is ${MAX_CODE_CHARS}`)], details: {}, isError: true };
      const timeoutMs = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(params.timeout ?? DEFAULT_TIMEOUT_S))) * 1000;

      const dir = await fs.mkdtemp(path.join(tmpdir(), "awui-eval-"));
      const scriptPath = path.join(dir, "cell.py");
      await fs.writeFile(scriptPath, code, { mode: 0o600 });
      try {
        const chunks: string[] = [];
        const exitCode = await new Promise<number>((resolve) => {
          const child: ChildProcess = spawn("python3", [scriptPath], { cwd: dir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
          const collect = (buf: Buffer) => chunks.push(buf.toString("utf8"));
          child.stdout?.on("data", collect);
          child.stderr?.on("data", collect);
          const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
          const onAbort = () => {
            clearTimeout(killer);
            child.kill("SIGKILL");
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          child.on("error", (error) => {
            clearTimeout(killer);
            chunks.length = 0;
            chunks.push(`could not start python3: ${error.message}`);
            resolve(-1);
          });
          child.on("close", (code, sig) => {
            clearTimeout(killer);
            signal?.removeEventListener("abort", onAbort);
            resolve(code ?? (sig ? -2 : 0));
          });
        });
        const output = bound(chunks.join(""));
        const timedOut = exitCode === -2;
        const started = exitCode !== -1;
        if (exitCode === 0) {
          return { content: [text(output === "" ? "(no output)" : output)], details: { exitCode } };
        }
        const why = !started ? output : timedOut ? `interrupted after ${timeoutMs / 1000}s` : `exited ${exitCode}`;
        return { content: [text(`${why}${output ? `\n\n${output}` : ""}`)], details: { exitCode }, isError: true };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
}
