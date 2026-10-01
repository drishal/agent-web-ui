import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ChatManager } from "./chats/manager.js";
import { ConfigError, loadConfig } from "./config.js";
import { liveOmpChildren } from "./harness/omp.js";
import { HarnessRegistry } from "./harness/registry.js";
import { loadOrCreateSecret, newLaunchToken, Security } from "./security.js";
import { ThemeStore } from "./theme.js";
import { Workspaces } from "./workspaces.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function findRoot(): Promise<string> {
  let dir = here;
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "agent-web-ui") return dir;
    } catch {
      // keep walking up
    }
    dir = path.dirname(dir);
  }
  throw new Error("Cannot locate agent-web-ui package root");
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`agent-web-ui: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const root = await findRoot();
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const secret = await loadOrCreateSecret(config.stateDir);
  const token = newLaunchToken();
  const security = new Security({
    port: config.port,
    allowedHosts: config.allowedHosts,
    allowedTailscaleUsers: config.allowedTailscaleUsers,
    secret,
    token,
  });
  const { workspaces, warnings } = await Workspaces.create(config.workspaceRoots, config.home);
  for (const w of warnings) console.error(`agent-web-ui: ${w}`);
  if (workspaces.rootList.length === 0) {
    console.error("agent-web-ui: no usable WORKSPACE_ROOTS");
    process.exit(1);
  }
  const registry = HarnessRegistry.fromConfig(config);
  for (const status of await registry.refreshStatus()) {
    const state = status.available ? `available (${status.version ?? "unknown version"})` : `unavailable: ${status.reason}`;
    console.log(`  ${status.displayName}: ${state}`);
    for (const w of status.warnings) console.log(`    warning: ${w}`);
    for (const [name, value] of Object.entries(status.overrides)) console.log(`    ${name}: ${value}`);
  }
  const theme = new ThemeStore(config.themeFile, config.themeFileExplicit, (m) => console.error(`agent-web-ui: ${m}`));
  const active = await theme.get();
  console.log(`  theme: ${active.name ?? "built-in light/dark"}`);
  const manager = new ChatManager();
  const pairingUrls = config.allowedHosts.map((h) => `https://${h}/?token=${token}`);
  const webDir = process.env.AWUI_WEB_DIR ?? path.join(root, "dist", "web");
  const app = createApp({
    version: pkg.version,
    home: config.home,
    registry,
    manager,
    workspaces,
    security,
    theme,
    pairingUrls,
    webDir,
    ...(process.env.AWUI_HEARTBEAT_MS ? { heartbeatMs: Number(process.env.AWUI_HEARTBEAT_MS) } : {}),
  });

  const server = http.createServer(app);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`agent-web-ui: port ${config.port} on 127.0.0.1 is already in use. Stop the other process or set PORT.`);
    } else {
      console.error(`agent-web-ui: cannot listen: ${error.message}`);
    }
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`agent-web-ui ${pkg.version} listening on http://${config.host}:${config.port}`);
    console.log(`Local: http://${config.host}:${config.port}/?token=${token}`);
    for (const url of pairingUrls) console.log(`Serve: ${url}`);
    if (!existsSync(path.join(webDir, "index.html"))) {
      console.log("  (no built UI found; run `npm run build`, or use `npm run dev`)");
    }
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`agent-web-ui: ${signal}, shutting down`);
    server.close();
    for (const socket of sockets) socket.destroy();
    await manager.shutdown();
    await registry.shutdown();
    const left = liveOmpChildren();
    console.log(`agent-web-ui: stopped (omp children left: ${left})`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}


main().catch((error: unknown) => {
  console.error(`agent-web-ui: fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
