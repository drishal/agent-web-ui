// `awui install service`: install the binary onto the PATH (~/.local/bin) and a
// systemd user unit that runs it, so awui starts with the session. The binary is
// copied by default; with --link it is symlinked instead (a dev checkout, where a
// rebuild should be live without reinstalling). The unit's Restart=always and the
// 78 exit-code carve-out match the source-run service (see contrib/systemd).
import { execFileSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatError } from "./chats/chat.js";

const UNIT_NAME = "awui.service";
const BIN_NAME = "awui";

/** Where awui installs itself: the user's bin and the user systemd dir. */
function installPaths(): { bin: string; binPath: string; unitDir: string; unitPath: string } {
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");
  const bin = path.join(home, ".local", "bin");
  const binPath = path.join(bin, BIN_NAME);
  const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user");
  return { bin, binPath, unitDir, unitPath: path.join(unitDir, UNIT_NAME) };
}

/** systemd reads % as a specifier and " as quoting: escape both inside quoted values. */
const unitValue = (s: string): string => s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** The service unit for a binary at `binPath`, with the shell's PATH so the agents resolve. */
function unitFor(binPath: string, pathEnv: string): string {
  const entries = pathEnv.split(":").filter((p) => p && !/[/\\]node_modules[/\\]\.bin$/.test(p));
  const pathVal = [...new Set(entries)].join(":");
  return `[Unit]
Description=awui: the web UI for Pi, omp, Hermes, and Claude Code
After=network.target

[Service]
ExecStart=${unitValue(binPath)}
# The shell's PATH when installed, so pi, omp, hermes, claude, and the agents' own tools are found.
Environment="PATH=${unitValue(pathVal)}"
Restart=always
RestartSec=5
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
`;
}

/** The legacy unit (the pre-rename node-run service): installing awui's binary retires it. */
const OLD_UNIT_NAME = "agent-web-ui.service";

/**
 * Install the binary at binPath (copy, or symlink when link=true), write the
 * unit, daemon-reload, and enable+start it. Self-path: `process.execPath` in the
 * binary; from source, the built dist/bin binary when present. A leftover
 * agent-web-ui.service from the old name is disabled first, so the two do not
 * fight over the port.
 */
export async function installService(opts: { link: boolean }): Promise<void> {
  const { bin, binPath, unitDir, unitPath } = installPaths();
  const oldUnitPath = path.join(unitDir, OLD_UNIT_NAME);
  if (existsSync(oldUnitPath)) {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", OLD_UNIT_NAME], { stdio: "inherit" });
    } catch {
      // Not loaded or not running: fine, the file is removed below either way.
    }
    await fs.rm(oldUnitPath, { force: true });
    console.log(`retired legacy ${OLD_UNIT_NAME}`);
  }
  const self = process.execPath;
  if (!existsSync(self)) throw new ChatError(500, "no_self", "cannot find the running awui binary to install");
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  if (opts.link) {
    await fs.rm(binPath, { force: true });
    await fs.symlink(self, binPath);
  } else {
    const tmp = `${binPath}.${process.pid}.tmp`;
    await fs.copyFile(self, tmp);
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, binPath);
  }
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  const unit = unitFor(binPath, process.env.PATH ?? "");
  const tmpUnit = `${unitPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpUnit, unit, { mode: 0o644 });
  await fs.rename(tmpUnit, unitPath);
  // Enable + start; tolerable failures are surfaced, not fatal (systemd may be absent).
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", UNIT_NAME], { stdio: "inherit" });
    console.log(`awui installed: ${binPath} → ${unitPath} (enabled, started)`);
  } catch (error) {
    throw new ChatError(500, "systemd_failed", `wrote ${unitPath} and ${binPath} but systemd failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
