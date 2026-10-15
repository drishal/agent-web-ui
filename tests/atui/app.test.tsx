// atui end to end: the built server with fake harnesses, atui in OpenTUI's
// test renderer, driven by keys and clicks as a person would.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { RGBA, TextAttributes } from "@opentui/core";
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
    expect(f).toContain("Fake Echo ▾  low ▾");
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

  it("shows a reply written between tool calls as a reply, before the fold holding the command", async () => {
    ui = await mount(path.join(server.root, "beta"), { height: 40 });
    await ui.type("interleaved please");
    ui.keys.pressEnter();
    await idle(ui);
    const f = await ui.until("Echo: interleaved please");
    const reply = f.indexOf("this is reply block 1");
    const fold = f.search(/▸ Worked for \d+s · 1 command/);
    expect(reply).toBeGreaterThan(0);
    expect(fold).toBeGreaterThan(reply);
    expect(f.indexOf("Echo: interleaved please")).toBeGreaterThan(fold);
    // Opened, the fold holds the command, not the reply again.
    await ui.click("▸ Worked");
    const open = await ui.until("● Bash");
    // (The fake's thought quotes the reply, after "Considering:".)
    expect(open.match(/(?<!Considering: )this is reply block 1/g)).toHaveLength(1);
  }, 30_000);

  it("flashes the prompt's edge once when a run ends", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("tool please");
    ui.keys.pressEnter();
    await idle(ui);
    const ok = RGBA.fromHex(ui.app.theme().ok).toInts().join();
    const edge = async () => {
      const row = (await ui?.spans())?.find((l) => l.map((s) => s.text).join("").includes("╭─F"));
      return row?.find((s) => s.text.includes("╭"))?.fg.toInts().join();
    };
    // A tenth of a second in, the flash is near its height.
    await wait(100);
    const lit = await edge();
    expect(lit).toBeDefined();
    expect(lit).not.toBe(ok);
    await wait(1100);
    expect(await edge()).toBe(ok);
  }, 30_000);

  it("breathes a session that asks for you in the side panel", async () => {
    ui = await mount(path.join(server.root, "beta"), { width: 150 });
    await ui.type("please ask first");
    ui.keys.pressEnter();
    await ui.until("Waiting for approval");
    await ui.until(() => ui?.app.overview().sessions.some((s) => s.asking) ?? false);
    const mark = async () => (await ui?.spans())?.flat().find((s) => s.text.startsWith("▲"))?.fg.toInts().join();
    // Three looks a little apart: a breath cannot show the same colour at all of them.
    const seen = [await ui.until("▲ please ask first").then(mark)];
    for (const _ of [1, 2]) {
      await wait(400);
      seen.push(await mark());
    }
    expect(seen.every(Boolean)).toBe(true);
    expect(new Set(seen).size).toBeGreaterThan(1);
    ui.keys.pressKey("1");
    await idle(ui);
  }, 30_000);

  it("shows a running command's last lines under it, until its outcome takes their place", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("ticking please");
    ui.keys.pressEnter();
    const live = await ui.until("step-4.test.ts");
    // Three lines at a time, the newest last.
    expect(live).toContain("│  ✓ tests/unit/step-2.test.ts");
    expect(live).not.toContain("step-1.test.ts");
    expect(live).toContain("● Bash · running…");
    await idle(ui);
    expect(await ui.frame()).not.toContain("step-6.test.ts");
  }, 30_000);

  it("underlines a failure as well as colouring it", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("fail please");
    ui.keys.pressEnter();
    await ui.until("✗ Fake failure");
    const failure = (await ui.spans()).flat().find((s) => s.text.includes("Fake failure"));
    expect(failure && failure.attributes & TextAttributes.UNDERLINE).toBeTruthy();
    expect(failure?.text).not.toContain("✗");
  }, 30_000);

  it("changes thinking, model, and harness directly, hands the chat off, and opens history", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 50 });
    await ui.type("remember the harness");
    ui.keys.pressEnter();
    await ui.until("Echo: remember the harness");
    await idle(ui);
    // Alt+T: the thinking levels, picked by typing.
    ui.keys.pressKey("t", { meta: true });
    await ui.until("Search levels…");
    await ui.type("high");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.config.thinkingLevel === "high");
    expect(await ui.until("high ▾")).toContain("Fake Echo ▾");
    // Alt+M: the models.
    ui.keys.pressKey("m", { meta: true });
    await ui.until("Search models…");
    await ui.type("slow");
    ui.keys.pressEnter();
    await ui.until("Fake Slow ▾");
    // A click on the footer's harness: with a conversation open, it can move to another harness.
    await ui.click("Fake ▾");
    const picker = await ui.until("Hand off this chat to");
    expect(picker).toContain("Harness for new chats");
    await ui.type("fake b");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.harnessId === "fake-b", 15_000);
    expect(await ui.until("Fake B ▾")).toContain("remember the harness");
    // Ctrl+R: every session, under its project.
    ui.keys.pressKey("r", { ctrl: true });
    const history = await ui.until("Search sessions, projects, harnesses…");
    expect(history).toContain("remember the harness");
    expect(history).toContain("alpha");
  }, 40_000);

  it("moves around in vim mode: Esc for NORMAL, j/k and gg/G, : for commands, i to type again", async () => {
    ui = await mount(path.join(server.root, "beta"), { vim: true, height: 30 });
    expect(await ui.frame()).toContain("-- INSERT --");
    await ui.type("slow stream for scrolling");
    ui.keys.pressEnter();
    await ui.until("Echo: slow stream for scrolling");
    await idle(ui);
    await ui.escape();
    expect(await ui.until("-- NORMAL --")).toContain("gg/G top/bottom");
    // In NORMAL, letters move instead of typing: nothing reaches the composer.
    const before = await ui.frame();
    ui.keys.pressKey("g");
    ui.keys.pressKey("g");
    await wait(60);
    expect(await ui.frame()).not.toBe(before);
    ui.keys.pressKey("g", { shift: true });
    await wait(60);
    ui.keys.pressKey("k");
    ui.keys.pressKey("x");
    await wait(60);
    expect(ui.app.chat()?.items.filter((i) => i.kind === "user")).toHaveLength(1);
    // ":" is the palette; Esc closes it and stays in NORMAL.
    ui.keys.pressKey(":");
    await ui.until("Search commands, sessions, thinking…");
    await ui.escape();
    expect(await ui.frame()).toContain("-- NORMAL --");
    // i: back to typing.
    ui.keys.pressKey("i");
    await ui.until("-- INSERT --");
    await ui.type("typed again");
    expect(await ui.until("typed again")).toContain("-- INSERT --");
  }, 40_000);

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

    // C-x: the which-key panel lists every key until one is pressed.
    ui.keys.pressKey("x", { ctrl: true });
    const panel = await ui.until("C-x-");
    expect(panel).toContain("n → new chat");
    expect(panel).toContain("m → +model");
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
    // Where the answer is being written, a cursor blinks.
    await ui.until("▍");
    await ui.escape();
    await ui.until("Esc again to stop");
    await ui.escape();
    await ui.until("■ Stopped", 15_000);
    await idle(ui);
    expect(await ui.frame()).not.toContain("▍");
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until("C-c again to quit");
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until(() => ui?.exited() === true);
  }, 30_000);

  it("tips on the empty screen, ghosts a command, mentions a file, previews history, and toasts a background run", async () => {
    mkdirSync(path.join(server.root, "beta", "src"), { recursive: true });
    writeFileSync(path.join(server.root, "beta", "src", "server.ts"), "x");
    ui = await mount(path.join(server.root, "beta"), { width: 150, height: 44 });
    expect(await ui.frame()).toContain("Tip ");
    // "/comp": the menu lists /compact, and the rest of it shows after what was typed.
    await ui.type("/comp");
    const ghost = await ui.until("Summarize the conversation");
    expect(ghost.split("/compact").length - 1).toBeGreaterThanOrEqual(2);
    await ui.escape();
    for (let i = 0; i < 5; i++) ui.keys.pressBackspace();
    // "@": the project's files; Tab puts the path in.
    await ui.type("look at @serv");
    await ui.until("Tab or Enter inserts");
    ui.keys.pressTab();
    await ui.until("look at @src/server.ts");
    ui.keys.pressEnter();
    await ui.until("Echo: look at @src/server.ts");
    await idle(ui);
    // Ctrl+R on a wide screen: the highlighted session's last exchange beside the list.
    ui.keys.pressKey("r", { ctrl: true });
    await ui.until("1 turn");
    expect(await ui.frame()).toContain("› look at @src/server.ts");
    await ui.escape();
    // A run that finishes while another chat is shown: a toast in the corner.
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    await ui.type("slow stream in the background");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "running");
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    expect(await ui.until("✓ Done", 30_000)).toContain("slow stream in the");
  }, 60_000);

  it("attaches an image file dropped on the terminal and sends it under the prompt", async () => {
    const shot = path.join(server.root, "alpha", "shot.png");
    writeFileSync(shot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64"));
    ui = await mount(path.join(server.root, "alpha"), { height: 44 });
    // A drop pastes the file's path: it becomes a thumbnail, not text.
    await ui.keys.pasteBracketedText(shot);
    await ui.until("▣ #1  png 1 KB");
    expect(await ui.frame()).not.toContain("shot.png");
    await ui.type("what is in this picture");
    ui.keys.pressEnter();
    await ui.until("Echo: what is in this picture");
    await idle(ui);
    const prompt = ui.app.chat()?.items.find((i) => i.kind === "user");
    expect(prompt && prompt.kind === "user" ? prompt.imageCount : 0).toBe(1);
    expect(await ui.frame()).toContain("▣ #1");
  }, 30_000);

  it("keeps sessions and info in one side panel, switched by tab, folding to a rail", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 150, height: 40 });
    await ui.type("tool edit please");
    ui.keys.pressEnter();
    await ui.until("Echo: tool edit please");
    await idle(ui);
    expect(await ui.frame()).toContain("Sessions │ Info");
    // C-x i: the Info tab, where the right panel's context and usage now live.
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("i");
    const info = await ui.until("Tool definitions");
    expect(info).toContain("Context");
    // Each changed file with its stat bar.
    expect(info).toMatch(/\+\d+ −\d+ ■{5}/);
    await ui.click("Sessions");
    await ui.until("C-x s to browse");
    // « folds it to a rail; » unfolds it.
    await ui.click("«");
    const folded = await ui.until("»");
    expect(folded).not.toContain("Sessions │ Info");
    await ui.click("»");
    await ui.until("Sessions │ Info");
  }, 30_000);

  it("shows a ghost of the thread, named, while a session takes its time to open", async () => {
    ui = await mount(path.join(server.root, "beta"), { width: 150 });
    await ui.type("ghost session here");
    ui.keys.pressEnter();
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    await ui.until(() => ui?.app.overview().sessions.some((s) => s.title === "ghost session here") ?? false);
    const target = ui.app.overview().sessions.find((s) => s.title === "ghost session here");
    // A slow server: the chat arrives a second after it is asked for.
    const api = ui.app.server;
    const call = api.call.bind(api);
    api.call = (async (url: string, init?: unknown) => {
      if (url.startsWith("/api/chats/")) await wait(1000);
      return call(url, init as never);
    }) as typeof api.call;
    const opened = ui.app.openSession(target as NonNullable<typeof target>);
    const ghost = await ui.until("Opening ghost session here");
    expect(ghost).toContain("━━━━");
    expect(ghost).toContain("Fake");
    await opened;
    const thread = await ui.until("│ ghost session here");
    expect(thread).not.toContain("Opening");
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
    await ui.until("↑↓ Enter · Tab · Esc back");
    ui.keys.pressArrow("down");
    await wait(30);
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.title === "first session here");
    expect(await ui.frame()).toContain("│ first session here");
  }, 30_000);
});
