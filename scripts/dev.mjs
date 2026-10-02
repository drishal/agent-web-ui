#!/usr/bin/env node
// Development: backend under `tsx watch` plus Vite (which proxies /api to the
// backend). Local use needs no sign-in.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// The backend reads .env itself; Vite needs its PORT to proxy to it.
const envFile = process.env.AWUI_ENV_FILE ?? ".env";
const fileEnv = envFile && existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const port = process.env.PORT ?? fileEnv.PORT ?? "4783";
const children = [];

function run(name, command, args, onLine) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: port } });
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

run("server", "npx", ["tsx", "watch", "--clear-screen=false", "src/server/index.ts"], (line) => {
  if (/Local: http:\/\/127\.0\.0\.1:\d+\//.test(line)) process.stdout.write("\n  Dev UI: http://127.0.0.1:5173/\n\n");
});
run("vite", "npx", ["vite"]);
