// Request trust and authentication.
//  1. Host must be loopback or listed in ALLOWED_HOSTS; Origin must match Host;
//     cross-site fetches are refused. Failures are 403 (DNS rebinding, CSRF).
//  2. Non-loopback (Tailscale Serve) requests also need an allowed
//     Tailscale-User-Login, fail closed when ALLOWED_TAILSCALE_USERS is unset.
//  3. The printed launch token is exchanged on `GET /` for a signed,
//     host-bound, HttpOnly SameSite=Strict cookie; /api without it is 401.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SecurityOptions {
  port: number;
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
  secret: Buffer;
  token: string;
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

function send(res: Response, status: number, code: string, error: string): void {
  res.status(status).type("application/json").send(JSON.stringify({ error, code }));
}

export class Security {
  readonly cookieName: string;

  constructor(private readonly options: SecurityOptions) {
    this.cookieName = `awui_${options.port}`;
  }

  /** Classify a Host header: loopback, an allowed Serve host, or untrusted. */
  classify(hostHeader: string | undefined): { kind: "loopback" | "remote"; authority: string } | null {
    const auth = parseAuthority(hostHeader);
    if (!auth) return null;
    if (LOOPBACK.has(auth.hostname)) return { kind: "loopback", authority: auth.authority };
    for (const entry of this.options.allowedHosts) {
      const matches = entry.includes(":") ? entry === auth.authority : entry === auth.hostname;
      if (matches) return { kind: "remote", authority: auth.authority };
    }
    return null;
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
    if (host.kind === "remote") {
      const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
      const allowed = this.options.allowedTailscaleUsers;
      if (allowed.length === 0) {
        return send(res, 403, "tailscale_users_unset", "Remote access is disabled until ALLOWED_TAILSCALE_USERS is set");
      }
      if (!login || !allowed.includes(login)) {
        return send(res, 403, "tailscale_user_denied", "This Tailscale user is not allowed");
      }
    }
    res.locals.hostKind = host.kind;
    res.locals.authority = host.authority;
    next();
  };

  private sign(payload: string): string {
    return createHmac("sha256", this.options.secret).update(payload).digest("base64url");
  }

  issueCookie(authority: string, secure: boolean, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, h: authority, iat: now, exp: now + COOKIE_MAX_AGE_MS })).toString(
      "base64url",
    );
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

  isAuthenticated(req: Request, authority: string, now = Date.now()): boolean {
    const value = this.readCookie(req);
    if (!value) return false;
    const dot = value.indexOf(".");
    if (dot <= 0) return false;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { h?: string; exp?: number };
      return data.h === authority && typeof data.exp === "number" && data.exp > now;
    } catch {
      return false;
    }
  }

  tokenMatches(candidate: unknown): boolean {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.options.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** `GET /?token=…`: trade the launch token for a cookie, redirect to the clean URL. */
  exchange = (req: Request, res: Response, next: NextFunction): void => {
    if (!("token" in req.query)) return next();
    if (!this.tokenMatches(req.query.token)) {
      res.status(401).type("text/plain").send("This link has expired. Open the link printed by the server.");
      return;
    }
    const authority = res.locals.authority as string;
    res.setHeader("Set-Cookie", this.issueCookie(authority, res.locals.hostKind === "remote"));
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, "./");
  };

  requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.isAuthenticated(req, res.locals.authority as string)) {
      return send(res, 401, "unauthenticated", "Open the link printed by the server to sign this browser in");
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

export function newLaunchToken(): string {
  return randomBytes(24).toString("base64url");
}
