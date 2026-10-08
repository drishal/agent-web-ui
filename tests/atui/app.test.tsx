// atui end to end: the built server with fake harnesses, atui in OpenTUI's
// test renderer, driven by keys and clicks as a person would.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { mount, startServer, wait, type Mounted } from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let ui: Mounted | null = null;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.stop();
});
afterEach(() => {
  ui?.unmount();
  ui = null;
});

const idle = (m: Mounted) => m.until(() => m.app.chat()?.status === "idle", 15_000);

describe("atui", () => {
  it("sends a message, streams the answer, and shows the work, files, and context", async () => {
    // Tall enough for the whole opened turn: neat-render's rows take two lines and more.
    ui = await mount(path.join(server.root, "alpha"), { height: 80 });
    expect(await ui.frame()).toContain("What should Fake do in alpha?");
    await ui.type("showcase tool edit please");
    ui.keys.pressEnter();
    await ui.until("Echo: showcase tool edit please");
    await idle(ui);
    const f = await ui.until("Changed 3 files");
    expect(f).toContain("│ showcase tool edit please");
    expect(f).toMatch(/▸ Worked for \d+s · 2 reads, 1 search, 2 edits/);
    expect(f).toContain("Fake Echo · low");
    await ui.click("▸ Worked");
    // neat-render's rows: the edit as Update(path), its outcome on a └ line, its lines under it.
    const rows = await ui.until("Update(src/app.ts)");
    expect(rows).toContain("└ Added 1 line, removed 1 line");
    expect(rows).toMatch(/- a\s*\n.*\+ b/s);
    expect(rows).toContain("● Read README.md");
    // Clicked, it is framed, its outcome in the bottom edge.
    await ui.click("Update(src/app.ts)");
    const framed = await ui.until("╰─ Added 1 line, removed 1 line");
    expect(framed).toContain("╭");
  }, 30_000);

  it("answers an approval with a number and a question with the arrows", async () => {
    ui = await mount(path.join(server.root, "beta"));
    await ui.type("please ask first");
    ui.keys.pressEnter();
    expect(await ui.until("Waiting for approval")).toContain("› 1. Approve");
    ui.keys.pressKey("1");
    await ui.until("Echo: please ask first");
    await idle(ui);
    await ui.type("quiz described");
    ui.keys.pressEnter();
    const q = await ui.until("Waiting for your answer");
    expect(q).toContain("Should the theme and the text size both move into config.yml?");
    expect(q).toContain("Every device gets the same look.");
    ui.keys.pressArrow("down");
    await wait(30);
    ui.keys.pressEnter();
    await ui.until("Chose: Only text size");
  }, 30_000);

  it("lists commands on /, completes with Tab, and runs the palette and the model picker", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("hello");
    ui.keys.pressEnter();
    await ui.until("Echo: hello");
    await idle(ui);
    await ui.type("/fake");
    const menu = await ui.until("/fake-status");
    expect(menu).toContain("Tab completes");
    ui.keys.pressTab();
    await wait(50);
    ui.keys.pressEnter();
    await ui.until("fake status: all good");

    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("m");
    await ui.until("Search models");
    await ui.type("slow");
    await ui.until("Fake Slow");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.config.model === "fake/slow");
    await ui.type("one more");
    ui.keys.pressEnter();
    await ui.until("Switched to Fake Slow", 15_000);
    await idle(ui);

    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("new chat");
    ui.keys.pressEnter();
    await ui.until("What should Fake do in alpha?");
  }, 40_000);

  it("stops a run on Esc Esc and quits on Ctrl+C twice", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("slow stream please");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "running");
    await ui.until("Steer the agent");
    await ui.escape();
    await ui.until("Esc again to stop");
    await ui.escape();
    await ui.until("■ Stopped", 15_000);
    await idle(ui);
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until("Ctrl+C again to quit");
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until(() => ui?.exited() === true);
  }, 30_000);

  it("browses sessions from the sidebar and opens one", async () => {
    ui = await mount(path.join(server.root, "beta"));
    await ui.type("first session here");
    ui.keys.pressEnter();
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    await ui.until("What should Fake do in beta?");
    await ui.type("second session here");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.until(() => (ui?.app.overview().sessions.filter((s) => s.title.endsWith("session here")).length ?? 0) >= 2);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("s");
    await ui.until("↑↓ Enter · Esc back");
    ui.keys.pressArrow("down");
    await wait(30);
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.title === "first session here");
    expect(await ui.frame()).toContain("│ first session here");
  }, 30_000);
});
