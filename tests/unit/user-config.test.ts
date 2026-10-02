import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, configEnv, readUserConfig, uiSettings, UserConfigError } from "../../src/server/user-config.js";
import { tempDir } from "../helpers/app.js";

function folder(yaml?: string, mode = 0o644): string {
  const dir = path.join(tempDir("awui-config-"), "agentwebui");
  mkdirSync(dir);
  if (yaml !== undefined) writeFileSync(path.join(dir, "config.yml"), yaml, { mode });
  return dir;
}

describe("config.yml", () => {
  it("lives in $XDG_CONFIG_HOME/agentwebui; AWUI_CONFIG_DIR moves it and an empty one ignores it", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/agentwebui");
    expect(configDir({ AWUI_CONFIG_DIR: "/elsewhere" })).toBe("/elsewhere");
    expect(configDir({ AWUI_CONFIG_DIR: "" })).toBeNull();
    expect(readUserConfig(null)).toBeNull();
    expect(readUserConfig(folder())).toBeNull();
  });

  it("maps its settings onto the server's variables", () => {
    const dir = folder(`# comments are fine
port: 4800
host: 0.0.0.0
auth:
  username: drishal
  password: "correct horse"
workspace_roots: [/home/x/code, /srv]
allowed_hosts: [box.tail.ts.net]
theme: base16
autocollapse_sidebar: false
`);
    const read = readUserConfig(dir);
    expect(read && configEnv(read.config)).toEqual({
      PORT: "4800",
      HOST: "0.0.0.0",
      AUTH_USERNAME: "drishal",
      AUTH_PASSWORD: "correct horse",
      WORKSPACE_ROOTS: `/home/x/code${path.delimiter}/srv`,
      ALLOWED_HOSTS: "box.tail.ts.net",
    });
    expect(uiSettings(read?.config)).toEqual({ theme: "base16", autocollapseSidebar: false });
    // The old name still works.
    expect(uiSettings(readUserConfig(folder("theme: custom\n"))?.config).theme).toBe("base16");
  });

  it("defaults the browser settings, and an empty file is no settings", () => {
    expect(uiSettings(undefined)).toEqual({ theme: null, autocollapseSidebar: true });
    expect(readUserConfig(folder(""))?.config).toEqual({});
  });

  it("narrows a file holding a password to its owner", () => {
    const dir = folder("auth:\n  username: a\n  password: long-enough\n");
    expect(readUserConfig(dir)?.tightened).toBe(true);
    expect(statSync(path.join(dir, "config.yml")).mode & 0o777).toBe(0o600);
    expect(readUserConfig(folder("port: 4800\n"))?.tightened).toBe(false);
  });

  it("names the bad key instead of guessing", () => {
    expect(() => readUserConfig(folder("autocollapse_sidebar: yes\n"))).toThrow(/autocollapse_sidebar/);
    expect(() => readUserConfig(folder("thme: dark\n"))).toThrow(UserConfigError);
    expect(() => readUserConfig(folder("theme: [dark\n"))).toThrow(/not valid YAML/);
    expect(() => readUserConfig(folder("theme: blue\n"))).toThrow(/theme/);
  });
});
