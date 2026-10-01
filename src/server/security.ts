// Request trust and authentication.
//  1. Host must be loopback, listed in ALLOWED_HOSTS (Tailscale Serve), or,
//     with HOST=0.0.0.0, one of this machine's LAN addresses/hostname. Origin
//     must match Host; cross-site fetches are refused. Failures are 403
//     (DNS rebinding, CSRF).
//  2. Local use needs no sign-in: a request is local only when the TCP peer is
//     loopback, the Host is loopback, and no proxy headers are present (so a
//     LAN client faking `Host: 127.0.0.1`, or Tailscale Serve proxying over
//     loopback, is never local).
//  3. Everything else (LAN via HOST=0.0.0.0, Tailscale Serve) signs in with
//     username and password (POST /api/login) and gets a signed, host-bound,
//     HttpOnly, SameSite=Strict session cookie carrying the credential
//     fingerprint, so changing the password signs every device out.
//  4. If ALLOWED_TAILSCALE_USERS is set, Serve requests must also carry an
//     allowed Tailscale-User-Login.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { LoginLimiter, type PasswordAuth } from "./auth.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PROXY_HEADERS = ["tailscale-user-login", "tailscale-user-name", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FAIL_DELAY_MS = 400;

export interface SecurityOptions {
  port: number;
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
  secret: Buffer;
  /** Required for any non-local access; absent means local-only. */
  password?: PasswordAuth;
  /** HOST=0.0.0.0: hostnames of this machine reachable on the LAN. */
  lanHosts?: () => Set<string>;
  log?: (message: string) => void;
}

interface Authority {
  hostname: string;
  port: string;
  authority: string;
}

export function parseAuthority(value: string | undefined): Authority | null {
  if (!value || /[\s/@?#\\]/.test(value)) return null;
  try {
    const url = new URL(`http://${value.toLowerCase()}`);
    return { hostname: url.hostname, port: url.port, authority: url.port ? `${url.hostname}:${url.port}` : url.hostname };
  } catch {
    return null;
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function send(res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).type("application/json").send(JSON.stringify({ error, code, ...extra }));
}

export class Security {
  readonly cookieName: string;
  private readonly limiter = new LoginLimiter();

  constructor(private readonly options: SecurityOptions) {
    this.cookieName = `awui_${options.port}`;
  }

  get username(): string | null {
    return this.options.password?.username ?? null;
  }

  /** Classify a Host header: loopback, a LAN address (HOST=0.0.0.0), an allowed Serve host, or untrusted. */
  classify(hostHeader: string | undefined): { kind: "loopback" | "lan" | "remote"; authority: string } | null {
    const auth = parseAuthority(hostHeader);
    if (!auth) return null;
    if (LOOPBACK_HOSTS.has(auth.hostname)) return { kind: "loopback", authority: auth.authority };
    for (const entry of this.options.allowedHosts) {
      const matches = entry.includes(":") ? entry === auth.authority : entry === auth.hostname;
      if (matches) return { kind: "remote", authority: auth.authority };
    }
    if (this.options.lanHosts?.().has(auth.hostname)) return { kind: "lan", authority: auth.authority };
    return null;
  }

  /** Same machine, direct connection, no proxy in between. */
  isLocal(req: Request, hostKind: "loopback" | "lan" | "remote"): boolean {
    if (hostKind !== "loopback" || !isLoopbackAddress(req.socket.remoteAddress)) return false;
    return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  }

  /** Host / Origin / Sec-Fetch-Site / Tailscale identity. Applies to every request. */
  trust = (req: Request, res: Response, next: NextFunction): void => {
    const host = this.classify(req.headers.host);
    if (!host) return send(res, 403, "host_not_allowed", "Host not allowed");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") {
      let originAuthority: string | null = null;
      try {
        const url = new URL(origin);
        originAuthority = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      } catch {
        originAuthority = null;
      }
      if (originAuthority?.toLowerCase() !== host.authority) {
        return send(res, 403, "origin_not_allowed", "Cross-origin request refused");
      }
    } else if (origin === "null") {
      return send(res, 403, "origin_not_allowed", "Opaque origin refused");
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return send(res, 403, "cross_site", "Cross-site request refused");
    }
    const local = this.isLocal(req, host.kind);
    if (!local && !this.options.password) {
      return send(res, 403, "remote_disabled", "Access from other devices needs a password: run `npm run set-password`");
    }
    if (host.kind === "remote" && this.options.allowedTailscaleUsers.length > 0) {
      const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
      if (!login || !this.options.allowedTailscaleUsers.includes(login)) {
        return send(res, 403, "tailscale_user_denied", "This Tailscale user is not allowed");
      }
    }
    res.locals.hostKind = host.kind;
    res.locals.authority = host.authority;
    res.locals.local = local;
    next();
  };

  private sign(payload: string): string {
    return createHmac("sha256", this.options.secret).update(payload).digest("base64url");
  }

  issueCookie(authority: string, secure: boolean, now = Date.now()): string {
    const body = { v: 2, h: authority, iat: now, exp: now + COOKIE_MAX_AGE_MS, f: this.options.password?.fingerprint ?? "" };
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    const value = `${payload}.${this.sign(payload)}`;
    const attrs = [`${this.cookieName}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${COOKIE_MAX_AGE_MS / 1000}`];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  private readCookie(req: Request): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === this.cookieName) return part.slice(eq + 1).trim();
    }
    return null;
  }

  hasSession(req: Request, authority: string, now = Date.now()): boolean {
    const password = this.options.password;
    if (!password) return false;
    const value = this.readCookie(req);
    if (!value) return false;
    const dot = value.indexOf(".");
    if (dot <= 0) return false;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { h?: string; exp?: number; f?: string };
      // A cookie from before the password changed is void.
      return data.h === authority && typeof data.exp === "number" && data.exp > now && data.f === password.fingerprint;
    } catch {
      return false;
    }
  }

  /** POST /api/login { username, password }. */
  login = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const auth = this.options.password;
    if (!auth) return send(res, 404, "not_found", "Password sign-in is not configured");
    const address = req.socket.remoteAddress ?? "unknown";
    const key = `${address}|${String(req.headers["tailscale-user-login"] ?? "")}`;
    const wait = this.limiter.retryAfter(key);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return send(res, 429, "locked", `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });
    }
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.slice(0, 128) : "";
    const password = typeof body.password === "string" ? body.password.slice(0, 1024) : "";
    const ok = await auth.verify(username, password);
    if (!ok) {
      this.limiter.fail(key);
      this.options.log?.(`sign-in failed from ${address}`);
      await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
      return send(res, 401, "bad_credentials", "Wrong username or password");
    }
    this.limiter.succeed(key);
    res.setHeader("Set-Cookie", this.issueCookie(res.locals.authority as string, res.locals.hostKind === "remote"));
    res.json({ ok: true, username: auth.username });
  };

  logout = (_req: Request, res: Response): void => {
    res.setHeader("Set-Cookie", `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  };

  /** Local requests pass; everything else needs a password session. */
  requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (res.locals.local === true) return next();
    if (!this.hasSession(req, res.locals.authority as string)) {
      return send(res, 401, "unauthenticated", "Sign in with your username and password", { auth: "password" });
    }
    next();
  };
}

/** Load the cookie-signing secret, creating it with mode 0600 on first use. */
export async function loadOrCreateSecret(stateDir: string): Promise<Buffer> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, "cookie-secret");
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      const stat = await fs.stat(file);
      if ((stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
      return Buffer.from(existing, "hex");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, secret.toString("hex"), { mode: 0o600 });
  await fs.rename(tmp, file);
  return secret;
}
