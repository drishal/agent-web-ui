#!/usr/bin/env node
// Set the login for HOST=0.0.0.0 mode: `npm run set-password [-- <username>]`.
// Stores only a salted scrypt hash (mode 0600). With --stdin the password is
// read from standard input (one line) instead of a hidden prompt.
// Changing the password signs every device out.
// PARAMS and USERNAME_PATTERN are exported for tests/unit/credential-parity.test.ts,
// which pins them to auth.ts DEFAULTS and config.ts USERNAME_PATTERN.
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { existsSync, promises as fs, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
/** scrypt cost parameters — must stay equal to auth.ts DEFAULTS (parity test). */
export const PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
/** Login-name rule — must stay equal to config.ts USERNAME_PATTERN (parity test). */
export const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

function ask(question, hidden) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) return reject(new Error("No terminal for the prompt; use --stdin"));
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        } else if (ch.charCodeAt(0) === 127 || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!hidden) process.stdout.write("\b \b");
          }
          continue;
        } else {
          value += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdinLine() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0] ?? "";
}

async function main() {
  const args = process.argv.slice(2);
  const fromStdin = args.includes("--stdin");
  let username = args.find((a) => !a.startsWith("--"));

  // awui's state folder; the server moves an old agent-web-ui one on its next start, and so does this.
  const stateBase = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  const stateDir = path.join(stateBase, "awui");
  if (!existsSync(stateDir) && existsSync(path.join(stateBase, "agent-web-ui"))) renameSync(path.join(stateBase, "agent-web-ui"), stateDir);
  const file = process.env.AUTH_CREDENTIALS_FILE ? path.resolve(process.env.AUTH_CREDENTIALS_FILE) : path.join(stateDir, "credentials.json");

  try {
    if (!username) username = (await ask("Username: ", false)).trim();
    if (!USERNAME_PATTERN.test(username ?? "")) throw new Error("Username must be 1-64 letters, digits, or . _ @ -");
    let password;
    if (fromStdin) {
      password = await readStdinLine();
    } else {
      password = await ask("Password: ", true);
      const again = await ask("Repeat password: ", true);
      if (password !== again) throw new Error("Passwords do not match");
    }
    if (!password) throw new Error("Password cannot be empty");
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: 256 * PARAMS.N * PARAMS.r });
    const record = { v: 1, username, salt: salt.toString("base64"), hash: key.toString("base64"), ...PARAMS };
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
    console.log(`Saved login for "${username}" to ${file}. Existing sessions are signed out.`);
  } catch (error) {
    console.error(`set-password: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run only when executed (`node scripts/set-password.mjs`); the parity test imports the exports above.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) void main();
