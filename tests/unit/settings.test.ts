import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings, writeSettings, type SettingsContext } from "../../src/server/settings.js";
import { tempDir } from "../helpers/app.js";

function setup(yaml: string, overrides: Partial<SettingsContext> = {}) {
  const home = tempDir("awui-settings-");
  const dir = path.join(home, ".config", "agentwebui");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(home, "code"));
  const file = path.join(dir, "config.yml");
  if (yaml) writeFileSync(file, yaml);
  const ctx: SettingsContext = {
    configDir: dir,
    running: { port: 4783, host: "127.0.0.1", username: "", password: null, workspaceRoots: [home], allowedHosts: [], allowedTailscaleUsers: [] },
    envSet: new Set(),
    credentialsFile: path.join(home, "credentials.json"),
    canRestart: false,
    home,
    ...overrides,
  };
  return { ctx, file, home };
}

const FILE = `# My agent-web-ui settings
port: 4783 # the usual port
theme: base16
autocollapse_sidebar: true
`;

describe("settings", () => {
  it("reads config.yml with defaults for what it leaves out", () => {
    const { ctx } = setup(FILE);
    const view = readSettings(ctx, true);
    expect(view).toMatchObject({ editable: true, writable: true, restartPending: [], envOverrides: [], canRestart: false });
    expect(view.values).toEqual({
      port: 4783,
      host: "127.0.0.1",
      username: "",
      hasPassword: false,
      workspaceRoots: [],
      allowedHosts: [],
      allowedTailscaleUsers: [],
      theme: "base16",
      textScale: null,
      autocollapseSidebar: true,
    });
  });

  it("rewrites the file in place, keeping comments, and says what waits for a restart", () => {
    const { ctx, file, home } = setup(FILE);
    const code = path.join(home, "code");
    const view = writeSettings(ctx, { port: 4800, theme: null, textScale: 1.22, autocollapseSidebar: false, workspaceRoots: [code] });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# My agent-web-ui settings");
    expect(text).toContain("port: 4800 # the usual port");
    expect(text).not.toContain("theme:");
    expect(text).toContain("text_scale: 1.22");
    expect(text).toContain("autocollapse_sidebar: false");
    expect(text).toContain(`workspace_roots:\n  - ${code}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(view.values).toMatchObject({ port: 4800, theme: null, textScale: 1.22, autocollapseSidebar: false });
    // Port and roots take a restart; theme, text size, and folding apply on the next page load.
    expect(view.restartPending).toEqual(["port", "workspaceRoots"]);
  });

  it("keeps the password write-only and refuses to listen beyond this machine without a login", () => {
    const { ctx, file } = setup(FILE);
    expect(() => writeSettings(ctx, { host: "0.0.0.0" })).toThrow(/need a username and password/);
    expect(readFileSync(file, "utf8")).not.toContain("0.0.0.0");
    const view = writeSettings(ctx, { host: "0.0.0.0", username: "me", password: "s3cret pass" });
    expect(JSON.stringify(view)).not.toContain("s3cret");
    expect(view.values).toMatchObject({ host: "0.0.0.0", username: "me", hasPassword: true });
    expect(view.restartPending).toEqual(["host", "username", "password"]);
    expect(readFileSync(file, "utf8")).toContain("password: s3cret pass");
    // Removing it again: the auth block goes with it once empty.
    const cleared = writeSettings(ctx, { host: "127.0.0.1", username: "", password: null });
    expect(cleared.values.hasPassword).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("auth");
  });

  it("refuses what startup would refuse, writing nothing", () => {
    const { ctx, file } = setup(FILE);
    const before = readFileSync(file, "utf8");
    expect(() => writeSettings(ctx, { username: "has space", password: "x" })).toThrow(/username/);
    expect(() => writeSettings(ctx, { workspaceRoots: ["/no/such/folder"] })).toThrow(/workspace roots/);
    expect(() => writeSettings(ctx, { allowedHosts: ["bad host/path"] })).toThrow(/ALLOWED_HOSTS|allowed_hosts/i);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("creates config.yml when there is none, and names what the environment overrides", () => {
    const { ctx, file } = setup("", { envSet: new Set(["PORT"]) });
    const view = writeSettings(ctx, { allowedTailscaleUsers: ["Me@Example.com"] });
    expect(readFileSync(file, "utf8")).toBe("allowed_tailscale_users:\n  - Me@Example.com\n");
    expect(view.envOverrides).toEqual(["port"]);
    expect(view.restartPending).toEqual(["allowedTailscaleUsers"]);
  });

  it("has nothing to write to without a settings folder", () => {
    const { ctx } = setup(FILE, { configDir: null });
    expect(readSettings(ctx, true).writable).toBe(false);
    expect(() => writeSettings(ctx, { port: 1 })).toThrow(/without a settings folder/);
  });
});
