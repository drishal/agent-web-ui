// A stand-in for herdr's API socket (herdr.dev): one JSON line in, one out, as
// herdr answers. `agent.list` gives what `agents()` says at the time; pane
// reports and focusing a listed pane succeed; anything else is herdr's error.
import net from "node:net";

export interface FakeHerdr {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function startFakeHerdr(socket: string, agents: () => unknown[], onCall?: (call: FakeHerdr["calls"][number]) => void): Promise<FakeHerdr> {
  const calls: FakeHerdr["calls"] = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as { id: string; method: string; params: Record<string, unknown> };
      const call = { method: req.method, params: req.params };
      calls.push(call);
      onCall?.(call);
      const listed = agents() as Array<{ pane_id?: string }>;
      const reply =
        req.method === "agent.list"
          ? { id: req.id, result: { type: "agent_list", agents: listed } }
          : req.method.startsWith("pane.report") || (req.method === "agent.focus" && listed.some((a) => a.pane_id === req.params.target))
            ? { id: req.id, result: { type: "ok" } }
            : { id: req.id, error: { code: "pane_not_found", message: "no such pane" } };
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
