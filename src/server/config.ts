import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_PORT = 4783;

export interface ServerConfig {
  port: number;
  /** Bind address: 127.0.0.1 (this machine, no sign-in) or 0.0.0.0 (LAN; other devices sign in). */
  host: "127.0.0.1" | "0.0.0.0";
  /** Password-mode credentials (scrypt hash written by `npm run set-password`). */
  credentialsFile: string;
  /** Login from AUTH_USERNAME/AUTH_PASSWORD; takes precedence over credentialsFile. */
  login: { username: string; password: string } | null;
  workspaceRoots: string[];
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
  themeFile: string | null;
  themeFileExplicit: boolean;
  stateDir: string;
  ompAgentDir: string | null;
  ompSessionDir: string | null;
  /** Comma list selecting adapters; tests use `fake`. Default: pi,omp. */
  harnesses: string[];
  home: string;
}

export class ConfigError extends Error {}

/** Same rules as `npm run set-password`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
export const MIN_PASSWORD_LENGTH = 8;

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

const portSchema = z.coerce
  .number()
  .int("PORT must be an integer")
  .min(1024, "PORT must be between 1024 and 65535")
  .max(65535, "PORT must be between 1024 and 65535");

const list = (value: string | undefined, sep: string | RegExp = ","): string[] =>
  (value ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

/** Normalize an ALLOWED_HOSTS entry to a lowercase `host` or `host:port` authority. */
export function normalizeAuthority(entry: string): string {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed || /[\s/@?#]/.test(trimmed)) throw new ConfigError(`Invalid ALLOWED_HOSTS entry: ${entry}`);
  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    throw new ConfigError(`Invalid ALLOWED_HOSTS entry: ${entry}`);
  }
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const home = homedir();
  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && env.PORT !== "") {
    const parsed = portSchema.safeParse(env.PORT);
    if (!parsed.success) throw new ConfigError(parsed.error.issues[0]?.message ?? "Invalid PORT");
    port = parsed.data;
  }
  const roots = list(env.WORKSPACE_ROOTS, path.delimiter).map((r) => path.resolve(expandHome(r, home)));
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const xdgState = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  const themeFile = env.THEME_FILE ? path.resolve(expandHome(env.THEME_FILE, home)) : null;
  const host = env.HOST === undefined || env.HOST === "" ? "127.0.0.1" : env.HOST;
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new ConfigError("HOST must be 127.0.0.1 (default) or 0.0.0.0 (LAN, username/password sign-in)");
  }
  const stateDir = path.join(xdgState, "agent-web-ui");
  let login: ServerConfig["login"] = null;
  if (env.AUTH_PASSWORD) {
    const username = (env.AUTH_USERNAME ?? "").trim();
    if (!USERNAME_PATTERN.test(username)) {
      throw new ConfigError("AUTH_PASSWORD needs AUTH_USERNAME (1-64 letters, digits, or . _ @ -)");
    }
    if (env.AUTH_PASSWORD.length < MIN_PASSWORD_LENGTH) {
      throw new ConfigError(`AUTH_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    login = { username, password: env.AUTH_PASSWORD };
  }
  return {
    port,
    host,
    credentialsFile: env.AUTH_CREDENTIALS_FILE ? path.resolve(expandHome(env.AUTH_CREDENTIALS_FILE, home)) : path.join(stateDir, "credentials.json"),
    login,
    workspaceRoots: roots.length > 0 ? roots : [home],
    allowedHosts: list(env.ALLOWED_HOSTS).map(normalizeAuthority),
    allowedTailscaleUsers: list(env.ALLOWED_TAILSCALE_USERS).map((u) => u.toLowerCase()),
    themeFile: themeFile ?? path.join(xdgConfig, "agent-web-ui", "theme.yaml"),
    themeFileExplicit: themeFile !== null,
    stateDir,
    ompAgentDir: env.OMP_AGENT_DIR ? path.resolve(expandHome(env.OMP_AGENT_DIR, home)) : null,
    ompSessionDir: env.OMP_SESSION_DIR ? path.resolve(expandHome(env.OMP_SESSION_DIR, home)) : null,
    harnesses: list(env.AWUI_HARNESSES).length > 0 ? list(env.AWUI_HARNESSES) : ["pi", "omp"],
    home,
  };
}
