// awui's Tern client end to end: the built server with fake harnesses, the
// client's real state and view, and a stand-in Tern (tern-fake.ts) that keeps
// the document the frames build. Driven by the bytes a pty would carry.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { createRoot } from "solid-js";
import { connect } from "@stencil-hq/tern";
import { Server } from "../../src/atui/client.js";
import { createAtui, type Atui } from "../../src/atui/state.js";
import { createTernApp } from "../../src/tern/app.js";
import { BASE, startServer, wait } from "./helpers.js";
import { FakeTern } from "./tern-fake.js";

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.stop();
});

interface Client {
  tern: FakeTern;
  app: Atui;
  written: string[];
  running: Promise<void>;
  until: (check: () => boolean, what: string, ms?: number) => Promise<void>;
  quit: () => Promise<void>;
}

let client: Client | null = null;
afterEach(async () => {
  await client?.quit();
  client = null;
});

async function start(project = "alpha"): Promise<Client> {
  const tern = new FakeTern();
  const app = createRoot(() => createAtui(new Server(BASE), { cwd: path.join(server.root, project), harness: "fake" }));
  await app.init();
  const session = await connect({ app: "awui", input: tern.input, output: tern.output, env: { TERM_PROGRAM: "tern" }, exitHooks: false, features: ["edit", "undo", "send"] });
  if (!session) throw new Error("the stand-in Tern did not answer hello");
  const written: string[] = [];
  const ui = createTernApp(session, app, { url: BASE, version: "test", polarity: null, write: (s) => void written.push(s) });
  const running = ui.run();
  let done = false;
  void running.then(() => (done = true));
  const until = async (check: () => boolean, what: string, ms = 10_000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}; main:\n${tern.text("main")}\ndock:\n${tern.text("dock")}\nlayer:\n${tern.text("layer")}`);
      await wait(30);
    }
  };
  await until(() => tern.nodes.has("dock"), "the first frame");
  return {
    tern,
    app,
    written,
    running,
    until,
    quit: async () => {
      if (!done) {
        tern.type("\x18");
        await wait(40);
        tern.type("q");
        await Promise.race([running, wait(2000)]);
      }
      app.dispose();
      await session.close();
    },
  };
}

describe("awui tern", () => {
  it("opens one inline surface with the stylesheet and palette, and the welcome", async () => {
    client = await start();
    const { tern } = client;
    expect(tern.sent.find((m) => m.verb === "o")?.body).toMatchObject({ mode: "inline", role: "awui.chat" });
    expect(tern.sent.some((m) => m.verb === "s" && (m.body as { name: string }).name === "awui")).toBe(true);
    expect(tern.sent.some((m) => m.verb === "t")).toBe(true);
    expect(tern.text("main")).toContain("awui");
    expect(tern.text("main")).toContain("Fake B");
    expect(tern.focus).toBe("dock.d.comp.ed");
    expect(tern.errors).toEqual([]);
  });

  it("sends a message and draws the prompt, the folded work, and the streamed answer", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("tool please");
    await until(() => tern.nodes.get("dock.d.comp.ed")?.p.text === "tool please", "the draft");
    tern.type("\r");
    await until(() => tern.text("main").includes("Echo: tool please") && app.chat()?.status === "idle", "the answer");
    const main = tern.text("main");
    expect(main).toContain("tool please");
    expect(main).toMatch(/Worked for \d+s · /);
    expect(tern.find("md").some((n) => n.p.role === "awui.reply" && n.p.stream === false)).toBe(true);
    // The fold opens on a toggle from Tern, and holds the tool rows.
    const fold = tern.find("section").find((n) => n.p.role === "awui.fold");
    expect(fold).toBeDefined();
    expect(tern.find("tool").length).toBeGreaterThan(0);
    expect(tern.nodes.get("dock.d.comp.ed")?.p.text ?? "").toBe("");
    expect(tern.errors).toEqual([]);
  });

  it("answers an approval with its number key", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("ask please\r");
    await until(() => tern.nodes.has("dock.d.req"), "the approval card");
    expect(tern.text("dock")).toContain("Approve");
    tern.type("1");
    await until(() => !tern.nodes.has("dock.d.req") && app.chat()?.status === "idle", "the approval to go");
    expect(tern.text("main")).toContain("Approved");
  });

  it("opens the palette with C-k and the / menu at the caret, and Tab completes", async () => {
    client = await start();
    const { tern, until } = client;
    tern.type("\x0b");
    await until(() => tern.find("picker", "layer").length === 1, "the palette");
    expect(tern.text("layer")).toContain("Commands");
    tern.type("\x1b");
    await until(() => tern.find("picker", "layer").length === 0, "the palette to close");
    tern.type("/");
    await until(() => tern.find("overlay", "layer").length === 1, "the / menu");
    expect(tern.find("overlay", "layer")[0]?.p.anchor).toEqual({ caret: "dock.d.comp.ed" });
    expect(tern.text("layer")).toContain("/new");
    tern.type("\t");
    await until(() => String(tern.nodes.get("dock.d.comp.ed")?.p.text).startsWith("/new "), "the completion");
  });

  it("toggles a fold from Tern's event and keeps it open", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("tool please\r");
    await until(() => app.chat()?.status === "idle" && tern.find("section").some((n) => n.p.role === "awui.fold"), "the fold");
    const fold = tern.find("section").find((n) => n.p.role === "awui.fold") as { id: string; p: Record<string, unknown> };
    expect(fold.p.collapsed).toBe(true);
    tern.event({ ev: "toggle", id: fold.id, collapsed: false });
    await until(() => tern.nodes.get(fold.id)?.p.collapsed === false, "the fold to stay open");
  });

  it("offers the model before the first message: the chip starts the chat and opens the picker", async () => {
    client = await start();
    const { tern, app, until } = client;
    const chip = tern.nodes.get("dock.d.comp.chips.l.m");
    expect(chip?.p.text).toBe("Model ⌄");
    expect(app.chat()).toBeNull();
    tern.event({ ev: "action", id: "dock.d.comp.chips.l.m", act: "click" });
    const labels = () => ((tern.find("picker", "layer")[0]?.p.items ?? []) as Array<{ label: string }>).map((i) => i.label);
    await until(() => labels().includes("Fake Echo"), "the model picker");
    expect(app.chat()).not.toBeNull();
    expect(String(tern.nodes.get("dock.d.comp.chips.l.m")?.p.text)).not.toBe("Model ⌄");
  });

  it("quits with C-c C-c, and leaves the chat on the server", async () => {
    client = await start();
    const { tern, app, running, until } = client;
    tern.type("hello\r");
    await until(() => app.chat()?.status === "idle", "the run");
    tern.type("\x03");
    await wait(40);
    tern.type("\x03");
    await Promise.race([running, wait(3000).then(() => Promise.reject(new Error("C-c C-c did not quit")))]);
    expect(app.chat()?.chatId).toBeTruthy();
  });
});
