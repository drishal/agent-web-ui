import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile } from "../../src/server/env-file.js";
import { tempDir } from "../helpers/app.js";

function write(text: string, mode = 0o600): string {
  const file = path.join(tempDir(), ".env");
  writeFileSync(file, text, { mode });
  return file;
}

describe("loadEnvFile", () => {
  it("returns null when there is no file", () => {
    expect(loadEnvFile(path.join(tempDir(), ".env"), {})).toBeNull();
  });

  it("fills only unset variables, so the real environment wins", () => {
    const file = write('# comment\nPORT=5000\nHOST=0.0.0.0\nAUTH_PASSWORD="two words"\n');
    const env: NodeJS.ProcessEnv = { PORT: "6000" };
    const loaded = loadEnvFile(file, env);
    expect(env).toEqual({ PORT: "6000", HOST: "0.0.0.0", AUTH_PASSWORD: "two words" });
    expect(loaded?.applied.toSorted()).toEqual(["AUTH_PASSWORD", "HOST"]);
  });

  it("narrows a readable file to 0600 only when it holds a password", () => {
    const plain = write("PORT=5000\n", 0o644);
    expect(loadEnvFile(plain, {})?.tightened).toBe(false);
    expect(statSync(plain).mode & 0o777).toBe(0o644);

    const secret = write("AUTH_PASSWORD=hunter2hunter2\n", 0o644);
    expect(loadEnvFile(secret, {})?.tightened).toBe(true);
    expect(statSync(secret).mode & 0o777).toBe(0o600);

    const empty = write("AUTH_PASSWORD=\n", 0o644);
    expect(loadEnvFile(empty, {})?.tightened).toBe(false);
  });
});
