import { randomBytes } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateSecret, Security } from "../../src/server/security.js";
import { makeTestApp, signedIn, TOKEN, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("request trust", () => {
  it("serves /api/health without auth but 401s other API calls", async () => {
    t = await makeTestApp();
    const agent = request.agent(t.server);
    expect((await agent.get("/api/health")).status).toBe(200);
    const res = await agent.get("/api/bootstrap");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthenticated");
  });

  it("rejects a foreign Host header (DNS rebinding) with 403", async () => {
    t = await makeTestApp();
    const res = await request(t.server).get("/api/health").set("Host", "evil.example:4783");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("host_not_allowed");
  });

  it("rejects a mismatched Origin and cross-site fetches", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const host = `127.0.0.1:${t.port}`;
    expect((await agent.get("/api/bootstrap").set("Origin", "http://evil.example")).status).toBe(403);
    expect((await agent.get("/api/bootstrap").set("Origin", "http://localhost:9999")).status).toBe(403);
    expect((await agent.get("/api/bootstrap").set("Origin", "null")).status).toBe(403);
    expect((await agent.get("/api/bootstrap").set("Sec-Fetch-Site", "cross-site")).status).toBe(403);
    expect((await agent.get("/api/bootstrap").set("Origin", `http://${host}`)).status).toBe(200);
  });

  it("exchanges the launch token for a host-bound HttpOnly SameSite=Strict cookie", async () => {
    t = await makeTestApp();
    const res = await request(t.server).get(`/?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("./");
    const cookie = String((res.headers["set-cookie"] as unknown as string[])[0]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/Secure/);
    const agent = await signedIn(t);
    expect((await agent.get("/api/bootstrap")).status).toBe(200);
  });

  it("refuses a wrong token and never accepts the token on API routes", async () => {
    t = await makeTestApp();
    expect((await request(t.server).get("/?token=nope")).status).toBe(401);
    expect((await request(t.server).get(`/api/bootstrap?token=${TOKEN}`)).status).toBe(401);
    expect((await request(t.server).get("/api/bootstrap").set("Authorization", `Bearer ${TOKEN}`)).status).toBe(401);
  });

  it("does not accept a cookie minted for another host:port", async () => {
    t = await makeTestApp();
    const cookie = t.security.issueCookie("127.0.0.1:1", false).split(";")[0] as string;
    expect((await request(t.server).get("/api/bootstrap").set("Cookie", cookie)).status).toBe(401);
  });

  it("rejects tampered and expired cookies", async () => {
    t = await makeTestApp();
    const authority = `127.0.0.1:${t.port}`;
    const good = t.security.issueCookie(authority, false).split(";")[0] as string;
    const tampered = `${good.slice(0, -3)}AAA`;
    expect((await request(t.server).get("/api/bootstrap").set("Cookie", tampered)).status).toBe(401);
    const expired = t.security.issueCookie(authority, false, Date.now() - 31 * 24 * 3600_000).split(";")[0] as string;
    expect((await request(t.server).get("/api/bootstrap").set("Cookie", expired)).status).toBe(401);
    expect((await request(t.server).get("/api/bootstrap").set("Cookie", good)).status).toBe(200);
  });
});

describe("Tailscale Serve hosts", () => {
  it("fails closed when ALLOWED_TAILSCALE_USERS is unset", async () => {
    t = await makeTestApp({ allowedHosts: ["box.tail1234.ts.net"] });
    const res = await request(t.server)
      .get("/api/health")
      .set("Host", "box.tail1234.ts.net")
      .set("Tailscale-User-Login", "me@example.com");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("tailscale_users_unset");
  });

  it("admits only listed Tailscale users and marks the cookie Secure", async () => {
    t = await makeTestApp({ allowedHosts: ["box.tail1234.ts.net"], allowedTailscaleUsers: ["me@example.com"] });
    const denied = await request(t.server)
      .get("/api/health")
      .set("Host", "box.tail1234.ts.net")
      .set("Tailscale-User-Login", "other@example.com");
    expect(denied.status).toBe(403);
    expect((await request(t.server).get("/api/health").set("Host", "box.tail1234.ts.net")).status).toBe(403);
    const ok = await request(t.server)
      .get(`/?token=${TOKEN}`)
      .set("Host", "box.tail1234.ts.net")
      .set("Tailscale-User-Login", "ME@example.com");
    expect(ok.status).toBe(302);
    expect(String((ok.headers["set-cookie"] as unknown as string[])[0])).toMatch(/Secure/);
  });
});

describe("cookie secret", () => {
  it("is created once with mode 0600 and reused", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "awui-state-")), "agent-web-ui");
    const a = await loadOrCreateSecret(dir);
    const b = await loadOrCreateSecret(dir);
    expect(a.equals(b)).toBe(true);
    expect(statSync(path.join(dir, "cookie-secret")).mode & 0o777).toBe(0o600);
  });

  it("classifies loopback names on any port and allowed hosts exactly", () => {
    const s = new Security({ port: 4783, allowedHosts: ["a.ts.net", "b.example:8443"], allowedTailscaleUsers: [], secret: randomBytes(32), token: "x" });
    expect(s.classify("localhost:5173")?.kind).toBe("loopback");
    expect(s.classify("[::1]:4783")?.kind).toBe("loopback");
    expect(s.classify("a.ts.net")?.kind).toBe("remote");
    expect(s.classify("b.example:8443")?.kind).toBe("remote");
    expect(s.classify("b.example")).toBeNull();
    expect(s.classify("127.0.0.1.evil.example")).toBeNull();
    expect(s.classify("user@127.0.0.1")).toBeNull();
  });
});
