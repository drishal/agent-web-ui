import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { E2E_PORT } from "../../playwright.config.js";

/** Start the built server with fake harnesses; read the launch token from stdout. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const base = mkdtempSync(path.join(tmpdir(), "awui-e2e-"));
  const root = path.join(base, "workspaces");
  for (const name of ["alpha", "beta", ".hidden-proj"]) mkdirSync(path.join(root, name), { recursive: true });
  const themeFile = path.join(base, "theme.yaml");
  copyFileSync(path.join(import.meta.dirname, "..", "fixtures", "themes", "stylix.yaml"), themeFile);
  const server: ChildProcess = spawn(process.execPath, ["dist/server/server/index.js"], {
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      AWUI_HARNESSES: "fake,fake-b",
      AWUI_FAKE_DELAY_MS: "30",
      AWUI_HEARTBEAT_MS: "1000",
      WORKSPACE_ROOTS: root,
      XDG_STATE_HOME: path.join(base, "state"),
      THEME_FILE: themeFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const m = /Local: http:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]+)/.exec(output);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.once("exit", (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
  process.env.AWUI_E2E_TOKEN = token;
  process.env.AWUI_E2E_ROOT = root;
  return async () => {
    if (server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  };
}
