import { readFileSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildThemeVars, contrast, parseScheme, ThemeError, ThemeStore } from "../../src/server/theme.js";
import { tempDir } from "../helpers/app.js";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "..", "fixtures", "themes", name), "utf8");

describe("parseScheme", () => {
  it("reads the stylix-generated shape (no #, base24 keys, fonts)", () => {
    const s = parseScheme(fixture("stylix.yaml"));
    expect(s.name).toBe("stylix");
    expect(s.palette.base00).toBe("#1d2021");
    expect(s.palette.base17).toBe("#d3869b");
    expect(s.polarity).toBe("dark");
    expect(s.fonts).toEqual({ sans: "Google Sans", mono: "CommitMonoFixed Nerd Font" });
  });

  it("reads tinted-theming base24 and honours variant", () => {
    const s = parseScheme(fixture("tinted-base24.yaml"));
    expect(s.name).toBe("Test Base24 Light");
    expect(s.polarity).toBe("light");
    expect(Object.keys(s.palette)).toHaveLength(24);
  });

  it("reads legacy flat base16 and keeps leading zeros", () => {
    const s = parseScheme(fixture("legacy.yaml"));
    expect(s.name).toBe("Legacy Ocean");
    expect(s.palette.base00).toBe("#001122");
    expect(s.palette.base10).toBeUndefined();
    expect(s.polarity).toBe("dark");
  });

  it("rejects CSS injection, missing keys, and non-mappings", () => {
    expect(() => parseScheme(fixture("injection.yaml"))).toThrow(ThemeError);
    expect(() => parseScheme("palette:\n  base00: '000000'\n")).toThrow(/missing base01/);
    expect(() => parseScheme("- a\n- b\n")).toThrow(/mapping/);
    expect(() => parseScheme("a: [unclosed")).toThrow(/YAML/);
  });

  it("drops font names that could escape a CSS font stack", () => {
    const text = fixture("stylix.yaml").replace('sans: "Google Sans"', 'sans: "x\\"; } body { color: red"');
    expect(parseScheme(text).fonts.sans).toBeUndefined();
  });
});

describe("buildThemeVars", () => {
  it("meets contrast targets for every role", () => {
    for (const name of ["stylix.yaml", "tinted-base24.yaml", "legacy.yaml"]) {
      const { vars } = buildThemeVars(parseScheme(fixture(name)));
      const bg = vars["--bg"] as string;
      const surface = vars["--surface"] as string;
      for (const role of ["--text", "--text-2", "--link", "--danger", "--warn", "--ok", "--info"]) {
        expect(contrast(vars[role] as string, bg), `${name} ${role}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(vars[role] as string, surface), `${name} ${role} on surface`).toBeGreaterThanOrEqual(4.5);
      }
      for (const role of ["--accent", "--muted", "--thinking"]) {
        expect(contrast(vars[role] as string, bg), `${name} ${role}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(vars["--accent-fg"] as string, vars["--accent"] as string)).toBeGreaterThanOrEqual(3);
      for (const value of Object.values(vars)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("raises an unreadable role instead of shipping it", () => {
    const text = fixture("legacy.yaml").replace('base05: "c0c5ce"', 'base05: "1a2a3a"');
    const { vars, adjusted } = buildThemeVars(parseScheme(text));
    expect(adjusted).toContain("text");
    expect(contrast(vars["--text"] as string, vars["--bg"] as string)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses base24 bright colors for hover states when present", () => {
    const { vars } = buildThemeVars(parseScheme(fixture("tinted-base24.yaml")));
    expect(vars["--accent-hover"]).toBe("#5588ff");
  });
});

describe("ThemeStore", () => {
  it("falls back to built-ins for a missing explicit file and logs once", async () => {
    const logs: string[] = [];
    const store = new ThemeStore("/nonexistent/theme.yaml", true, (m) => logs.push(m));
    const a = await store.get();
    await store.get();
    expect(a.source).toBe("none");
    expect(a.problem).toMatch(/does not exist/);
    expect(logs).toHaveLength(1);
  });

  it("is silent when the default path simply does not exist", async () => {
    const logs: string[] = [];
    const info = await new ThemeStore("/nonexistent/theme.yaml", false, (m) => logs.push(m)).get();
    expect(info.problem).toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it("follows a symlink that gets repointed (home-manager switch)", async () => {
    const dir = tempDir("awui-theme-");
    writeFileSync(path.join(dir, "a.yaml"), fixture("stylix.yaml"));
    writeFileSync(path.join(dir, "b.yaml"), fixture("legacy.yaml"));
    const link = path.join(dir, "theme.yaml");
    symlinkSync(path.join(dir, "a.yaml"), link);
    const store = new ThemeStore(link, true, () => undefined);
    expect((await store.get()).name).toBe("stylix");
    symlinkSync(path.join(dir, "b.yaml"), `${link}.new`);
    renameSync(`${link}.new`, link);
    expect((await store.get()).name).toBe("Legacy Ocean");
  });

  it("reports an invalid file without leaking its content", async () => {
    const dir = tempDir("awui-theme-");
    const file = path.join(dir, "bad.yaml");
    writeFileSync(file, fixture("injection.yaml"));
    const info = await new ThemeStore(file, true, () => undefined).get();
    expect(info.source).toBe("none");
    expect(info.problem).toMatch(/base00/);
    expect(JSON.stringify(info)).not.toMatch(/evil/);
  });
});
