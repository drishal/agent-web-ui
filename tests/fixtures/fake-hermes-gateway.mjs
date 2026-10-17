#!/usr/bin/env node
// A scripted Hermes gateway for attach tests. It serves the two things a client needs
// to attach — the home's control socket (`identify`, `session-ticket`) and the
// `/api/ws` JSON-RPC transport, admitted by a ticket subprotocol — and puts one
// scripted `tui_gateway` child (fake-hermes.mjs, the same scripts) behind each
// connection. So a test drives the real client path without a real Hermes:
// identify → ticket → upgrade → frames.
//
// Usage: fake-hermes-gateway.mjs <home>   (prints "ready" on stdout once listening;
// FAKE_HERMES_STATE is passed to the child, as the stdio fake reads it.)
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const home = process.argv[2];
if (!home) throw new Error("usage: fake-hermes-gateway.mjs <home>");

const instanceId = process.env.FAKE_HERMES_INSTANCE ?? "fake-instance";
const tickets = new Map();
const controlPath = path.join(home, "gateway.sock");

// ── WebSocket, server side (RFC 6455), text frames only ──────────────────────
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptKey = (key) => createHash("sha1").update(`${key}${GUID}`).digest("base64");

function frame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

/** Frames a client sends, one message at a time (masked, unfragmented). */
function readFrames(onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = buffer.subarray(offset, offset + maskLength);
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      buffer = buffer.subarray(offset + maskLength + length);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) return onClose();
      if (opcode === 0x9) continue; // ping: the client keeps its own time
      if (opcode !== 0x1) continue;
      onMessage(payload.toString("utf8"));
    }
  };
}

// ── The gateway ─────────────────────────────────────────────────────────────
const server = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const ticket = protocols.find((value) => value.startsWith("hermes-gateway-ticket."))?.slice("hermes-gateway-ticket.".length);
  const grant = ticket ? tickets.get(ticket) : undefined;
  if (req.url !== "/api/ws" || !protocols.includes("hermes-gateway-v1") || !grant) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  tickets.delete(ticket); // single use, as the real one is
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(req.headers["sec-websocket-key"] ?? ""))}`,
      "Sec-WebSocket-Protocol: hermes-gateway-v1",
      "",
      "",
    ].join("\r\n"),
  );

  // The session RPC behind this connection: the stdio fake, bridged both ways.
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "fake-hermes.mjs")], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    lines.close();
    child.kill("SIGTERM");
    try {
      socket.destroy();
    } catch {
      // Already gone.
    }
  };
  lines.on("line", (line) => {
    if (open && line.trim()) socket.write(frame(line));
  });
  child.once("exit", () => {
    if (!open) return;
    open = false;
    try {
      socket.end(Buffer.from([0x88, 0x00])); // a close frame, then the socket
    } catch {
      // Already gone.
    }
  });
  socket.on("data", readFrames((text) => child.stdin.write(`${text}\n`), close));
  socket.on("close", close);
  socket.on("error", close);
});

// ── The control socket: identify, session-ticket ─────────────────────────────
const control = net.createServer((peer) => {
  let data = "";
  peer.on("data", (chunk) => {
    data += chunk.toString("utf8");
    const end = data.indexOf("\n");
    if (end < 0) return;
    let request = {};
    try {
      request = JSON.parse(data.slice(0, end));
    } catch {
      // Answered below as an unknown verb.
    }
    const reply = (result, error) =>
      peer.end(`${JSON.stringify({ ok: error === undefined, protocol: 1, id: request.id ?? 1, ...(error === undefined ? { result } : { error }) })}\n`);
    if (request.verb === "identify") reply(identify());
    else if (request.verb === "session-ticket") {
      const params = request.params ?? {};
      if (params.instance_id !== instanceId || params.purpose !== "interactive" || params.profile_id !== home) reply(undefined, "invalid bootstrap parameters");
      else {
        const ticket = randomBytes(32).toString("base64url");
        tickets.set(ticket, { profileId: params.profile_id, instanceId });
        reply({ ticket, expires_in_seconds: 30, instance_id: instanceId, profile_id: params.profile_id, runtime_protocol: 1 });
      }
    } else reply(undefined, `unknown verb: ${String(request.verb)}`);
  });
  peer.on("error", () => undefined);
});

function identify() {
  const port = server.address()?.port ?? 0;
  return {
    runtime_protocol: 1,
    state: "ready",
    served_profiles: [{ profile_id: home, home }],
    capabilities: ["session-authority-v1", "event-replay-v1"],
    authority_epoch: 1,
    instance_id: instanceId,
    api_origin: `http://127.0.0.1:${port}`,
    supervisor: "none",
    code_version: "1.2.3",
    code_sha: "fakesha1234",
  };
}

server.listen(0, "127.0.0.1", () => {
  try {
    unlinkSync(controlPath);
  } catch {
    // Nothing stale there.
  }
  control.listen(controlPath, () => {
    process.on("exit", () => {
      try {
        unlinkSync(controlPath);
      } catch {
        // Already gone.
      }
    });
    console.log("ready");
  });
});
