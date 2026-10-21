// Which git repository a project folder belongs to, on which branch, and
// whether it is the repository's own working tree or a linked worktree: the
// sidebar keeps a repository's projects together, the one you are in first,
// then the main branch, then the other branches and worktrees (as Hermes
// Desktop orders its lanes). Two git calls per folder, cached briefly; a
// folder outside git, or a git that fails, has no checkout.
import { createHash } from "node:crypto";
import type { Checkout } from "../shared/protocol.js";
import { git } from "./git.js";

const TTL_MS = 30_000;
const TIMEOUT_MS = 5_000;

const cache = new Map<string, { at: number; value: Promise<Checkout | null> }>();

export function checkoutOf(folder: string, now = Date.now()): Promise<Checkout | null> {
  const hit = cache.get(folder);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = read(folder);
  cache.set(folder, { at: now, value });
  // Folders come and go with the sidebar's projects; drop what has gone stale.
  if (cache.size > 500) for (const [key, entry] of cache) if (now - entry.at >= TTL_MS) cache.delete(key);
  return value;
}

async function read(folder: string): Promise<Checkout | null> {
  try {
    const [common, own] = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { cwd: folder, timeoutMs: TIMEOUT_MS })).trim().split("\n");
    if (!common || !own) return null;
    // Exit 1 with no output: HEAD is detached.
    const branch = (await git(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: folder, timeoutMs: TIMEOUT_MS, okExit: [1] })).trim();
    return { repo: createHash("sha256").update(common).digest("base64url").slice(0, 16), branch: branch || null, primary: common === own };
  } catch {
    return null;
  }
}
