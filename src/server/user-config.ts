// The user's settings: ~/.config/agentwebui/config.yml (YAML, so it can carry
// comments), with the base16/base24 theme.yml beside it. Real environment
// variables win over the file; AWUI_CONFIG_DIR moves the folder ("" ignores
// it, as the tests do).
import { chmodSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const CONFIG_FILE = "config.yml";
export const THEME_FILE = "theme.yml";

export type ThemeChoice = "system" | "light" | "dark" | "custom";

/** What the browser needs from config.yml; re-read on every page load. */
export interface UiSettings {
  /** null: no preference, so a theme.yml is used when present. */
  theme: ThemeChoice | null;
  autocollapseSidebar: boolean;
}

export class UserConfigError extends Error {}

const schema = z
  .object({
    port: z.number().int().optional(),
    host: z.string().optional(),
    auth: z.object({ username: z.string().optional(), password: z.string().optional() }).strict().optional(),
    workspace_roots: z.array(z.string()).optional(),
    allowed_hosts: z.array(z.string()).optional(),
    allowed_tailscale_users: z.array(z.string()).optional(),
    theme: z.enum(["system", "light", "dark", "custom"]).optional(),
    autocollapse_sidebar: z.boolean().optional(),
  })
  .strict();

export type UserConfig = z.infer<typeof schema>;

/** The settings folder, or null when AWUI_CONFIG_DIR is set to "". */
export function configDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AWUI_CONFIG_DIR !== undefined) return env.AWUI_CONFIG_DIR ? path.resolve(env.AWUI_CONFIG_DIR) : null;
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agentwebui");
}

/** config.yml parsed and checked, or null when there is none. A file holding a password is made 0600. */
export function readUserConfig(dir: string | null): { file: string; config: UserConfig; tightened: boolean } | null {
  if (!dir) return null;
  const file = path.join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UserConfigError(`cannot read ${file}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 10 }) ?? {};
  } catch (error) {
    throw new UserConfigError(`${file} is not valid YAML: ${(error as Error).message.split("\n")[0]}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "top level";
    throw new UserConfigError(`${file}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  let tightened = false;
  if (parsed.data.auth?.password && (statSync(file).mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
    tightened = true;
  }
  return { file, config: parsed.data, tightened };
}

/** The file's settings as the environment variables loadConfig reads. */
export function configEnv(c: UserConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (c.port !== undefined) env.PORT = String(c.port);
  if (c.host !== undefined) env.HOST = c.host;
  if (c.auth?.username) env.AUTH_USERNAME = c.auth.username;
  if (c.auth?.password) env.AUTH_PASSWORD = c.auth.password;
  if (c.workspace_roots?.length) env.WORKSPACE_ROOTS = c.workspace_roots.join(path.delimiter);
  if (c.allowed_hosts?.length) env.ALLOWED_HOSTS = c.allowed_hosts.join(",");
  if (c.allowed_tailscale_users?.length) env.ALLOWED_TAILSCALE_USERS = c.allowed_tailscale_users.join(",");
  return env;
}

export function uiSettings(c: UserConfig | undefined): UiSettings {
  return { theme: c?.theme ?? null, autocollapseSidebar: c?.autocollapse_sidebar ?? true };
}
