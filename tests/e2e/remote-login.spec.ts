import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// A real HOST=0.0.0.0 server reached through this machine's LAN address, so
// the browser is "another device": it must sign in with username/password.
const PORT = 4792;
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

test.describe("other devices (HOST=0.0.0.0)", () => {
  test.skip(!lanIp, "no LAN IPv4 address on this machine");
  let server: ChildProcess | null = null;
  const base = `http://${lanIp}:${PORT}`;

  test.beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-remote-"));
    const root = path.join(dir, "workspaces");
    mkdirSync(path.join(root, "proj"), { recursive: true });
    const creds = path.join(dir, "credentials.json");
    execFileSync(process.execPath, ["scripts/set-password.mjs", "alice", "--stdin"], {
      input: "lan-password-123\n",
      env: { ...process.env, AUTH_CREDENTIALS_FILE: creds },
    });
    server = spawn(process.execPath, ["dist/server/server/index.js"], {
      env: {
        ...process.env,
        HOST: "0.0.0.0",
        PORT: String(PORT),
        AUTH_CREDENTIALS_FILE: creds,
        AWUI_HARNESSES: "fake",
        WORKSPACE_ROOTS: root,
        XDG_STATE_HOME: path.join(dir, "state"),
        THEME_FILE: path.join(dir, "none.yaml"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
      const onData = (c: Buffer) => {
        out += c.toString();
        if (out.includes(`LAN:   http://${lanIp}:${PORT}/`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      server?.stdout?.on("data", onData);
      server?.stderr?.on("data", onData);
    });
  });

  test.afterAll(async () => {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise((r) => server?.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  });

  test("sign in with username and password, then sign out", async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect((await page.request.get(`${base}/api/bootstrap`)).status()).toBe(401);
    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Wrong username or password");
    await page.getByLabel("Password").fill("lan-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible();
    await page.getByRole("button", { name: "Pair phone" }).click();
    await expect(page.getByRole("dialog", { name: "Pair a phone" })).toContainText(`http://${lanIp}:${PORT}/`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("this machine's own localhost still needs no sign-in", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible();
  });
});
