import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Request } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, loadCredentials, LoginLimiter, PasswordAuth } from "../../src/server/auth.js";
import { loadOrCreateSecret, Security } from "../../src/server/security.js";
import { makeTestApp, PASS, type TestApp, USER } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const LAN = "192.168.1.50";
const lanHost = (port: number) => `${LAN}:${port}`;

describe("this machine", () => {
  it("needs no sign-in or token", async () => {
    t = await makeTestApp();
    const res = await request(t.server).get("/api/bootstrap");
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ mode: "local", username: null, remoteEnabled: false });
  });

  it("still refuses foreign Hosts (DNS rebinding) and cross-site requests", async () => {
    t = await makeTestApp();
    expect((await request(t.server).get("/api/health").set("Host", "evil.example:4783")).status).toBe(403);
    expect((await request(t.server).get("/api/bootstrap").set("Origin", "http://evil.example")).status).toBe(403);
    expect((await request(t.server).get("/api/bootstrap").set("Origin", "http://localhost:9999")).status).toBe(403);
    expect((await request(t.server).get("/api/bootstrap").set("Origin", "null")).status).toBe(403);
    expect((await request(t.server).get("/api/bootstrap").set("Sec-Fetch-Site", "cross-site")).status).toBe(403);
    expect((await request(t.server).get("/api/bootstrap").set("Origin", `http://127.0.0.1:${t.port}`)).status).toBe(200);
  });

  it("is never 'local' when proxied or when the TCP peer is not loopback", () => {
    const s = new Security({ port: 4783, allowedHosts: [], allowedTailscaleUsers: [], secret: randomBytes(32) });
    const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as unknown as Request;
    expect(s.isLocal(req("127.0.0.1"), "loopback")).toBe(true);
    expect(s.isLocal(req("::ffff:127.0.0.1"), "loopback")).toBe(true);
    expect(s.isLocal(req("::1"), "loopback")).toBe(true);
    // A LAN client faking Host: 127.0.0.1 is not local.
    expect(s.isLocal(req("192.168.1.9"), "loopback")).toBe(false);
    // Tailscale Serve / reverse proxies connect over loopback but are not local.
    expect(s.isLocal(req("127.0.0.1", { "tailscale-user-login": "me@x" }), "loopback")).toBe(false);
    expect(s.isLocal(req("127.0.0.1", { "x-forwarded-for": "10.0.0.2" }), "loopback")).toBe(false);
    expect(s.isLocal(req("127.0.0.1"), "lan")).toBe(false);
  });
});

describe("other devices", () => {
  it("are refused outright when no login is configured", async () => {
    t = await makeTestApp({ lanHosts: [LAN], allowedHosts: ["box.tail.ts.net"] });
    const lan = await request(t.server).get("/api/bootstrap").set("Host", lanHost(t.port));
    expect(lan.status).toBe(403);
    expect(lan.body.code).toBe("remote_disabled");
    expect((await request(t.server).get("/api/health").set("Host", "box.tail.ts.net")).status).toBe(403);
    expect((await request(t.server).get("/api/bootstrap").set("X-Forwarded-For", "10.0.0.2")).status).toBe(403);
  });

  it("only reach LAN addresses that belong to this machine", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    expect((await request(t.server).get("/api/health").set("Host", `192.168.1.51:${t.port}`)).status).toBe(403);
    expect((await request(t.server).get("/api/health").set("Host", lanHost(t.port))).status).toBe(200);
  });

  it("sign in with username and password and get a host-bound session", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    const anon = await request(t.server).get("/api/bootstrap").set("Host", host);
    expect(anon.status).toBe(401);
    expect(anon.body.auth).toBe("password");
    const bad = await request(t.server).post("/api/login").set("Host", host).send({ username: USER, password: "nope" });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("bad_credentials");
    expect(bad.headers["set-cookie"]).toBeUndefined();
    const wrongUser = await request(t.server).post("/api/login").set("Host", host).send({ username: "bob", password: PASS });
    expect(wrongUser.status).toBe(401);
    const ok = await request(t.server).post("/api/login").set("Host", host).send({ username: USER, password: PASS });
    expect(ok.status).toBe(200);
    const cookieHeader = String((ok.headers["set-cookie"] as unknown as string[])[0]);
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Strict/);
    expect(cookieHeader).not.toMatch(/Secure/);
    const cookie = cookieHeader.split(";")[0] as string;
    const me = await request(t.server).get("/api/bootstrap").set("Host", host).set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.auth).toEqual({ mode: "password", username: USER, remoteEnabled: true });
    // The cookie is bound to the host it was issued for.
    const other = await request(t.server).get("/api/bootstrap").set("X-Forwarded-For", "10.0.0.2").set("Cookie", cookie);
    expect(other.status).toBe(401);
    const out = await request(t.server).post("/api/logout").set("Host", host).set("Cookie", cookie);
    expect(String((out.headers["set-cookie"] as unknown as string[])[0])).toMatch(/Max-Age=0/);
  });

  it("are signed out when the password changes", async () => {
    const before = new PasswordAuth(await hashPassword(USER, PASS));
    const after = new PasswordAuth(await hashPassword(USER, "a brand new password"));
    expect(before.fingerprint).not.toBe(after.fingerprint);
    const secret = randomBytes(32);
    const s1 = new Security({ port: 4783, allowedHosts: [], allowedTailscaleUsers: [], secret, password: before });
    const s2 = new Security({ port: 4783, allowedHosts: [], allowedTailscaleUsers: [], secret, password: after });
    const cookie = s1.issueCookie("h:1", false).split(";")[0] as string;
    const req = { headers: { cookie } } as unknown as Request;
    expect(s1.hasSession(req, "h:1")).toBe(true);
    expect(s2.hasSession(req, "h:1")).toBe(false);
    expect(s1.hasSession(req, "h:2")).toBe(false);
  });

  it("are locked out after repeated failures", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    for (let i = 0; i < 5; i++) {
      expect((await request(t.server).post("/api/login").set("Host", host).send({ username: USER, password: "x" })).status).toBe(401);
    }
    const locked = await request(t.server).post("/api/login").set("Host", host).send({ username: USER, password: PASS });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("over Tailscale Serve use the password, plus the user allowlist when set", async () => {
    t = await makeTestApp({ withPassword: true, allowedHosts: ["box.tail.ts.net"], allowedTailscaleUsers: ["me@example.com"] });
    const denied = await request(t.server).get("/api/health").set("Host", "box.tail.ts.net").set("Tailscale-User-Login", "other@example.com");
    expect(denied.status).toBe(403);
    const anon = await request(t.server).get("/api/bootstrap").set("Host", "box.tail.ts.net").set("Tailscale-User-Login", "me@example.com");
    expect(anon.status).toBe(401);
    const ok = await request(t.server)
      .post("/api/login")
      .set("Host", "box.tail.ts.net")
      .set("Tailscale-User-Login", "ME@example.com")
      .send({ username: USER, password: PASS });
    expect(ok.status).toBe(200);
    expect(String((ok.headers["set-cookie"] as unknown as string[])[0])).toMatch(/Secure/);
  });
});

describe("credentials and secrets", () => {
  it("set-password writes a 0600 scrypt hash the server verifies", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-cred-"));
    const file = path.join(dir, "credentials.json");
    const script = path.join(import.meta.dirname, "..", "..", "scripts", "set-password.mjs");
    execFileSync(process.execPath, [script, "alice", "--stdin"], { input: "s3cret-passphrase\n", env: { ...process.env, AUTH_CREDENTIALS_FILE: file } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const creds = await loadCredentials(file);
    expect(JSON.stringify(creds)).not.toMatch(/s3cret/);
    const auth = new PasswordAuth(creds);
    expect(await auth.verify("alice", "s3cret-passphrase")).toBe(true);
    expect(await auth.verify("alice", "s3cret-passphras")).toBe(false);
    // Any non-empty password is accepted; an empty one is not.
    execFileSync(process.execPath, [script, "alice", "--stdin"], { input: "short\n", env: { ...process.env, AUTH_CREDENTIALS_FILE: file }, stdio: "pipe" });
    expect(await new PasswordAuth(await loadCredentials(file)).verify("alice", "short")).toBe(true);
    expect(() =>
      execFileSync(process.execPath, [script, "alice", "--stdin"], { input: "\n", env: { ...process.env, AUTH_CREDENTIALS_FILE: file }, stdio: "pipe" }),
    ).toThrow();
  });

  it("the lockout window expires", () => {
    const limiter = new LoginLimiter(2, 1000);
    limiter.fail("a", 0);
    expect(limiter.retryAfter("a", 10)).toBe(0);
    limiter.fail("a", 10);
    expect(limiter.retryAfter("a", 20)).toBeGreaterThan(0);
    expect(limiter.retryAfter("a", 2000)).toBe(0);
  });

  it("the cookie secret is created once with mode 0600 and reused", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "awui-state-")), "agent-web-ui");
    const a = await loadOrCreateSecret(dir);
    const b = await loadOrCreateSecret(dir);
    expect(a.equals(b)).toBe(true);
    expect(statSync(path.join(dir, "cookie-secret")).mode & 0o777).toBe(0o600);
  });

  it("classifies loopback names on any port and allowed hosts exactly", () => {
    const s = new Security({ port: 4783, allowedHosts: ["a.ts.net", "b.example:8443"], allowedTailscaleUsers: [], secret: randomBytes(32) });
    expect(s.classify("localhost:5173")?.kind).toBe("loopback");
    expect(s.classify("[::1]:4783")?.kind).toBe("loopback");
    expect(s.classify("a.ts.net")?.kind).toBe("remote");
    expect(s.classify("b.example:8443")?.kind).toBe("remote");
    expect(s.classify("b.example")).toBeNull();
    expect(s.classify("127.0.0.1.evil.example")).toBeNull();
    expect(s.classify("user@127.0.0.1")).toBeNull();
  });

  it("lets any signed-in device change the server settings, but not lock itself out", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN], withSettings: true });
    // As the running server is: on the network, with a login (set from this machine).
    const local = await request(t.server).put("/api/settings").send({ host: "0.0.0.0", username: USER, password: PASS });
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({ editable: true, values: { host: "0.0.0.0", hasPassword: true } });
    expect((await request(t.server).put("/api/settings").send({ port: "x" })).status).toBe(400);
    // Restarting needs a supervisor to bring the server back; this one has none.
    expect((await request(t.server).post("/api/settings/restart")).status).toBe(409);

    const host = lanHost(t.port);
    const login = await request(t.server).post("/api/login").set("Host", host).send({ username: USER, password: PASS });
    const cookie = String((login.headers["set-cookie"] as unknown as string[])[0]).split(";")[0] as string;
    const remote = (r: request.Test) => r.set("Host", host).set("Cookie", cookie);
    const saved = await remote(request(t.server).put("/api/settings")).send({ port: 4800, textScale: 1.1 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ editable: true, values: { port: 4800, textScale: 1.1 }, restartPending: expect.arrayContaining(["port"]) });
    // A phone on the LAN cannot move the server to this machine only: it would be shut out.
    const shut = await remote(request(t.server).put("/api/settings")).send({ host: "127.0.0.1" });
    expect(shut.status).toBe(422);
    expect(shut.body).toMatchObject({ code: "invalid_settings", error: expect.stringMatching(/lock this device out/) });
    expect((await request(t.server).get("/api/settings")).body.values.host).toBe("0.0.0.0");
    // This machine still can.
    expect((await request(t.server).put("/api/settings").send({ host: "127.0.0.1" })).status).toBe(200);
    // Not signed in at all: nothing.
    expect((await request(t.server).get("/api/settings").set("Host", host)).status).toBe(401);
  });
});
