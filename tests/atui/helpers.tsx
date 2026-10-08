// atui render tests: the built server with fake harnesses, and atui mounted
// in OpenTUI's test renderer against it.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRoot } from "solid-js";
import { testRender } from "@opentui/solid";
import { Server } from "../../src/atui/client.js";
import { createAtui, type Atui } from "../../src/atui/state.js";
import { App } from "../../src/atui/ui/app.js";
import { startTicker } from "../../src/atui/ui/ticker.js";

export const PORT = 4793;
export const BASE = `http://127.0.0.1:${PORT}`;

export async function startServer(): Promise<{ root: string; stop: () => Promise<void> }> {
  const base = mkdtempSync(path.join(tmpdir(), "atui-test-"));
  const root = path.join(base, "workspaces");
  for (const name of ["alpha", "beta"]) mkdirSync(path.join(root, name), { recursive: true });
  const server: ChildProcess = spawn("node", ["dist/server/server/index.js"], {
    env: {
      ...process.env,
      AWUI_CONFIG_DIR: "",
      PORT: String(PORT),
      AWUI_HARNESSES: "fake,fake-b",
      AWUI_FAKE_DELAY_MS: "20",
      AWUI_HEARTBEAT_MS: "1000",
      WORKSPACE_ROOTS: root,
      XDG_STATE_HOME: path.join(base, "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/Local: http:\/\/127\.0\.0\.1:\d+\//.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.once("exit", (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
  return {
    root,
    stop: async () => {
      if (server.exitCode !== null) return;
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    },
  };
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Mounted {
  app: Atui;
  frame: () => Promise<string>;
  keys: Awaited<ReturnType<typeof testRender>>["mockInput"];
  mouse: Awaited<ReturnType<typeof testRender>>["mockMouse"];
  /** Wait until the frame shows `text` (or the predicate holds). */
  until: (check: string | (() => boolean), ms?: number) => Promise<string>;
  /** Click on the first place the frame shows `text`. */
  click: (text: string) => Promise<void>;
  /** Esc and the keys after it need a pause, as in a terminal (Esc starts escape sequences). */
  escape: () => Promise<void>;
  type: (text: string) => Promise<void>;
  exited: () => boolean;
  unmount: () => void;
}

export async function mount(cwd: string, opts: { harness?: string; width?: number; height?: number } = {}): Promise<Mounted> {
  const app = createRoot(() => createAtui(new Server(BASE), { cwd, harness: opts.harness ?? "fake" }));
  await app.init();
  startTicker();
  let exited = false;
  const setup = await testRender(() => <App app={app} onExit={() => (exited = true)} />, { width: opts.width ?? 140, height: opts.height ?? 36 });
  const frame = async () => {
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const until = async (check: string | (() => boolean), ms = 8000) => {
    const start = Date.now();
    for (;;) {
      const f = await frame();
      if (typeof check === "string" ? f.includes(check) : check()) return f;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${typeof check === "string" ? JSON.stringify(check) : "a condition"}; frame:\n${f}`);
      await wait(50);
    }
  };
  const click = async (text: string) => {
    const rows = (await frame()).split("\n");
    for (let y = 0; y < rows.length; y++) {
      const x = (rows[y] as string).indexOf(text);
      if (x >= 0) {
        await setup.mockMouse.click(x + 1, y);
        await wait(60);
        return;
      }
    }
    throw new Error(`nothing shows ${JSON.stringify(text)}`);
  };
  return {
    app,
    frame,
    keys: setup.mockInput,
    mouse: setup.mockMouse,
    until,
    click,
    escape: async () => {
      setup.mockInput.pressEscape();
      await wait(120);
    },
    type: async (text) => {
      await setup.mockInput.typeText(text);
      await wait(20);
    },
    exited: () => exited,
    unmount: () => {
      app.dispose();
      setup.renderer.destroy();
    },
  };
}
