// `awui tern` (or `awui --tern`): start the Tern client in this pane. It is a
// Bun script like atui (src/tern/main.ts), so the server only finds it and
// hands the terminal over: from a checkout (or a binary built in one), the
// checkout's copy; from a downloaded binary, the copy `awui install tui`
// fetched into the state folder. Solid must load its reactive build there
// (--conditions=browser): the default Bun picks is Solid's server build,
// where effects never run.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = path.join("src", "tern", "main.ts");

/** The nearest folder up from `from` with a package.json, or null. */
function checkout(from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Where the Tern client's entry is: the checkout this server runs from (its
 * source, or a binary built into its dist/bin and linked from ~/.local/bin by
 * `awui install service --link`), else the copy `awui install tui` fetched.
 */
export function ternEntry(stateDir: string, embedded: boolean, execPath = process.execPath): string | null {
  let binary: string | null = null;
  try {
    binary = embedded ? path.dirname(realpathSync(execPath)) : null;
  } catch {
    binary = null;
  }
  const root = embedded ? (binary ? checkout(binary) : null) : checkout(path.dirname(fileURLToPath(import.meta.url)));
  const candidates = [root ? path.join(root, ENTRY) : null, path.join(stateDir, "atui", ENTRY)];
  return candidates.find((p): p is string => p !== null && existsSync(p)) ?? null;
}

/** The package version for the status strip: the binary's, else the checkout's package.json. */
function versionOf(entry: string, embedded: string | undefined): string {
  if (embedded) return embedded;
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(entry), "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ? `v${pkg.version}` : "dev";
  } catch {
    return "dev";
  }
}

/** Run the Tern client with `args` in this terminal, and exit with its status. */
export function runTern(args: string[], stateDir: string, embedded: { binary: boolean; version: string | undefined }): never {
  const entry = ternEntry(stateDir, embedded.binary);
  if (!entry) {
    console.error("awui tern: the Tern client is not installed; run `awui install tui` first (it fetches atui and the Tern client)");
    process.exit(1);
  }
  const bun = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (bun.error || bun.status !== 0) {
    console.error("awui tern needs Bun (1.3.14 or later): https://bun.sh");
    process.exit(1);
  }
  const child = spawnSync("bun", ["--conditions=browser", entry, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, AWUI_VERSION: versionOf(entry, embedded.version) },
  });
  if (child.error) {
    console.error(`awui tern: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}
