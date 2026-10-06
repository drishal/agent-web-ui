import { createHmac } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, RECENT_SESSIONS_PER_HARNESS } from "./app.js";
import { ChatManager } from "./chats/manager.js";
import { ConfigError, loadConfig } from "./config.js";
import { liveOmpChildren } from "./harness/omp.js";
import { HarnessRegistry } from "./harness/registry.js";
import { hashPassword, loadCredentials, PasswordAuth } from "./auth.js";
import { cachedLanHosts, sampleLanHosts } from "./network.js";
import { loadOrCreateSecret, Security } from "./security.js";
import { ThemeStore } from "./theme.js";
import { configDir, configEnv, readUserConfig, UserConfigError } from "./user-config.js";
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
  let settings: ReturnType<typeof readUserConfig> = null;
  let config;
  try {
    settings = readUserConfig(configDir());
    // Real environment variables win over config.yml; the password never enters process.env.
    config = loadConfig({ ...(settings ? configEnv(settings.config) : {}), ...process.env });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UserConfigError) {
      console.error(`agent-web-ui: ${error.message}`);
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
  // Which settings the environment overrides (they beat config.yml), noted before the password leaves it.
  const envSet = new Set(["PORT", "HOST", "AUTH_USERNAME", "AUTH_PASSWORD", "WORKSPACE_ROOTS", "ALLOWED_HOSTS", "ALLOWED_TAILSCALE_USERS"].filter((n) => process.env[n] !== undefined));
  // The agents' shells inherit process.env; the password must not reach them.
  delete process.env.AUTH_PASSWORD;
  if (settings) console.log(`  settings: ${settings.file}`);
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
          "agent-web-ui: host 0.0.0.0 and allowed_hosts need a login for other devices (auth.username and auth.password in config.yml, or `npm run set-password`); refusing to start.",
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
    const state = status.available ? `available (${status.versionDetail ?? status.version ?? "unknown version"})` : `unavailable: ${status.reason}`;
    console.log(`  ${status.displayName}: ${state}`);
    for (const w of status.warnings) console.log(`    warning: ${w}`);
    for (const [name, value] of Object.entries(status.overrides)) console.log(`    ${name}: ${value}`);
  }
  // Warm each harness's session listing now, so the first sidebar load does
  // not wait for it (a Hermes probe gateway alone takes ~2.4 s to start).
  for (const adapter of registry.list()) {
    if (registry.isAvailable(adapter.id)) void adapter.listRecentSessions(RECENT_SESSIONS_PER_HARNESS).catch(() => undefined);
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
    configDir: config.configDir,
    settings: {
      configDir: config.configDir,
      running: {
        port: config.port,
        host: config.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
        username: settings?.config.auth?.username ?? "",
        password: settings?.config.auth?.password ?? null,
        workspaceRoots: config.workspaceRoots,
        allowedHosts: config.allowedHosts,
        allowedTailscaleUsers: config.allowedTailscaleUsers,
      },
      envSet,
      credentialsFile: config.credentialsFile,
      // systemd sets INVOCATION_ID for its services; the unit restarts on any exit.
      canRestart: Boolean(process.env.INVOCATION_ID),
      home: config.home,
    },
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
