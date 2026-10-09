#!/usr/bin/env node
// Development: backend under `tsx watch` plus Vite (which proxies /api to the
// backend). Local use needs no sign-in.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

// Config folder and port come from the server's own loader, so Vite proxies to
// exactly the backend that `tsx watch` will start.
const { loadConfig } = await tsImport("../src/server/config.ts", import.meta.url);
const { configDir, configEnv, readUserConfig } = await tsImport("../src/server/user-config.ts", import.meta.url);

let config;
try {
  const settings = readUserConfig(configDir());
  config = loadConfig({ ...(settings ? configEnv(settings.config) : {}), ...process.env });
} catch (error) {
  // Same message and exit code the server gives a bad config.yml.
  console.error(`awui: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(78);
}
const port = String(config.port);

const children = [];

function run(name, command, args, onLine) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: port },
    shell: process.platform === "win32",
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        process.stdout.write(`[${name}] ${line}\n`);
        onLine?.(line);
      }
    });
  }
  child.on("exit", (code) => {
    process.stdout.write(`[${name}] exited (${code})\n`);
    shutdown(code ?? 1);
  });
  return child;
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("server", bin("tsx"), ["watch", "--clear-screen=false", "src/server/index.ts"], (line) => {
  if (/Local: http:\/\/127\.0\.0\.1:\d+\//.test(line)) process.stdout.write("\n  Dev UI: http://127.0.0.1:5173/\n\n");
});
run("vite", bin("vite"), []);
