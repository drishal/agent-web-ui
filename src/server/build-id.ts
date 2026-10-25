// The build a page was served from: a short hash of the served index.html, which
// names the content-hashed bundle. A UI rebuild changes it, a server-only change
// does not — and a stale page needs the former, not the latter. A long-lived page
// compares it with the server's (src/web/app-update.ts): an installed app has no
// reload button, and iOS drops pull-to-refresh, so a deploy would otherwise never
// reach it.
import { createHash } from "node:crypto";

export function buildIdOf(indexHtml: string | Buffer | null | undefined): string {
  return indexHtml ? createHash("sha256").update(indexHtml).digest("hex").slice(0, 10) : "dev";
}
