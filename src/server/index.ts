import { createHmac } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ChatManager } from "./chats/manager.js";
import { ConfigError, loadConfig } from "./config.js";
import { type LoadedEnvFile, loadEnvFile } from "./env-file.js";
import { liveOmpChildren } from "./harness/omp.js";
import { HarnessRegistry } from "./harness/registry.js";
import { hashPassword, loadCredentials, PasswordAuth } from "./auth.js";
import { cachedLanHosts, sampleLanHosts } from "./network.js";
import { loadOrCreateSecret, Security } from "./security.js";
import { ThemeStore } from "./theme.js";
import { Workspaces } from "./workspaces.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Bad settings (EX_CONFIG): retrying cannot help, so supervisors should not restart on it. */
const EXIT_CONFIG = 78;

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
  const root = await findRoot();
  const envFile = process.env.AWUI_ENV_FILE ?? path.join(root, ".env");
  let settings: LoadedEnvFile | null = null;
  try {
    settings = envFile ? loadEnvFile(envFile) : null;
  } catch (error) {
    console.error(`agent-web-ui: cannot read ${envFile}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_CONFIG);
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`agent-web-ui: ${error.message}`);
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
  // The agents' shells inherit process.env; the password must not reach them.
  delete process.env.AUTH_PASSWORD;
  if (settings) console.log(`  settings: ${settings.file} (${settings.applied.join(", ") || "nothing new"})`);
  if (settings?.tightened) console.log(`  ${settings.file} holds a password; its mode is now 0600`);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const secret = await loadOrCreateSecret(config.stateDir);
  // Other devices (LAN via HOST=0.0.0.0, or Tailscale Serve) sign in with a
  // password; this machine never needs to.
  const remote = config.host === "0.0.0.0" || config.allowedHosts.length > 0;
  let password: PasswordAuth | undefined;
  if (config.login) {
    // Salt from the install secret: the same password keeps the same cookie
    // fingerprint, so a restart does not sign devices out; a new one does.
    const salt = createHmac("sha256", secret).update(`login-salt\0${config.login.username}`).digest().subarray(0, 16);
    password = new PasswordAuth(await hashPassword(config.login.username, config.login.password, salt));
  } else {
    try {
      password = new PasswordAuth(await loadCredentials(config.credentialsFile));
    } catch (error) {
      if (remote) {
        console.error(`agent-web-ui: ${error instanceof Error ? error.message : String(error)}`);
        console.error(
          "agent-web-ui: HOST=0.0.0.0 and ALLOWED_HOSTS need a login for other devices (AUTH_USERNAME and AUTH_PASSWORD in .env, or `npm run set-password`); refusing to start.",
        );
        process.exit(EXIT_CONFIG);
      }
    }
  }
  const security = new Security({
    port: config.port,
    allowedHosts: config.allowedHosts,
    allowedTailscaleUsers: config.allowedTailscaleUsers,
    secret,
    ...(password ? { password } : {}),
    ...(config.host === "0.0.0.0" ? { lanHosts: cachedLanHosts() } : {}),
    log: (m) => console.error(`agent-web-ui: ${m}`),
  });
  const { workspaces, warnings } = await Workspaces.create(config.workspaceRoots, config.home);
  for (const w of warnings) console.error(`agent-web-ui: ${w}`);
  if (workspaces.rootList.length === 0) {
    console.error("agent-web-ui: no usable WORKSPACE_ROOTS");
    process.exit(EXIT_CONFIG);
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
  const lanUrls = config.host === "0.0.0.0" ? sampleLanHosts().ipv4.map((ip) => `http://${ip}:${config.port}/`) : [];
  const pairingUrls = [...lanUrls, ...config.allowedHosts.map((h) => `https://${h}/`)];
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
    console.log(`Local: http://127.0.0.1:${config.port}/ (no sign-in on this machine)`);
    for (const url of lanUrls) console.log(`LAN:   ${url}`);
    for (const h of config.allowedHosts) console.log(`Serve: https://${h}/`);
    if (password && remote) {
      console.log(`  other devices sign in as "${password.username}" (${config.login ? "AUTH_PASSWORD" : "npm run set-password"})`);
    }
    if (lanUrls.length > 0) {
      console.log("  warning: LAN access is plain HTTP; the password and chats are not encrypted on the network. Prefer Tailscale.");
    }
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
