#!/usr/bin/env node
// Install awui as a systemd user service from this checkout:
//   npm run service -- install     write the unit, enable it, start it
//   npm run service -- uninstall   stop it, disable it, remove the unit
//   npm run service -- print       show the unit it would write
// The unit (contrib/systemd/awui.service) gets this checkout's path,
// this node, and the current shell's PATH, so the harness CLIs resolve as they
// do in a terminal. A unit managed by home-manager (a link into /nix/store) is
// left alone: change it in the Nix config instead.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "awui";
/** The unit this script installed before the rename; install replaces it. */
const OLD_NAME = "agent-web-ui";
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(APP_DIR, "contrib", "systemd", `${NAME}.service`);

/** systemd reads % as a specifier and " as quoting: escape both inside quoted values. */
const unitValue = (s) => s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * The unit for `appDir`, run by `node`, with `pathEnv` as its PATH. npm's own
 * node_modules/.bin entries (npm run prepends them) are dropped.
 */
export function renderUnit(template, { appDir, node, pathEnv }) {
  const entries = pathEnv.split(":").filter((p) => p && !/[/\\]node_modules[/\\]\.bin$/.test(p));
  const values = { "@APP_DIR@": appDir, "@NODE@": node, "@PATH@": [...new Set(entries)].join(":") };
  return template.replace(/@(APP_DIR|NODE|PATH)@/g, (m) => unitValue(values[m]));
}

const unitDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd", "user");

function systemctl(...args) {
  execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

/** Whether `file` is a unit something else manages (home-manager links it into /nix/store). */
function managedElsewhere(file) {
  try {
    return lstatSync(file).isSymbolicLink() && readlinkSync(file).startsWith("/nix/store/");
  } catch {
    return false;
  }
}

function main() {
  const command = process.argv[2] ?? "help";
  const file = path.join(unitDir(), `${NAME}.service`);
  const unit = () => renderUnit(readFileSync(TEMPLATE, "utf8"), { appDir: APP_DIR, node: process.execPath, pathEnv: process.env.PATH ?? "" });
  if (command === "print") {
    process.stdout.write(unit());
    return;
  }
  if (command !== "install" && command !== "uninstall") {
    console.log("Usage: npm run service -- install | uninstall | print");
    process.exitCode = command === "help" ? 0 : 2;
    return;
  }
  if (managedElsewhere(file)) {
    console.error(`${file} is managed by home-manager (a link into /nix/store); change it in your Nix config instead.`);
    process.exitCode = 1;
    return;
  }
  if (command === "uninstall") {
    if (!existsSync(file)) {
      console.log(`No ${NAME} unit at ${file}.`);
      return;
    }
    try {
      systemctl("disable", "--now", NAME);
    } catch {
      // Already stopped, or systemd is not running for this user: the file still goes.
    }
    rmSync(file);
    systemctl("daemon-reload");
    console.log(`Removed ${file}.`);
    return;
  }
  if (!existsSync(path.join(APP_DIR, "dist", "server", "server", "index.js"))) {
    console.error("Build first: npm run build (the unit runs dist/, and skips itself until it exists).");
    process.exitCode = 1;
    return;
  }
  // The unit this script wrote under the old name would hold the same port: replace it.
  const oldFile = path.join(unitDir(), `${OLD_NAME}.service`);
  if (existsSync(oldFile) && !managedElsewhere(oldFile) && readFileSync(oldFile, "utf8").startsWith("# agent-web-ui as a systemd user service.")) {
    try {
      systemctl("disable", "--now", OLD_NAME);
    } catch {
      // Not running: the file still goes.
    }
    rmSync(oldFile);
    console.log(`Removed the old ${oldFile}.`);
  }
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(file, unit());
  systemctl("daemon-reload");
  systemctl("enable", "--now", NAME);
  systemctl("restart", NAME);
  console.log(`
Installed ${file}
  Status:  systemctl --user status ${NAME}
  Logs:    journalctl --user -u ${NAME} -n 20
  Update:  git pull && npm ci && npm run build && systemctl --user restart ${NAME}
To keep it running while you are logged out: loginctl enable-linger "$USER"
Node and PATH were fixed at install time; after moving either, run install again.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
