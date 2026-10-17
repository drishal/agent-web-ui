import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesAdapter, liveHermesLinks } from "../../src/server/harness/hermes.js";
import { tempDir } from "../helpers/app.js";

// Attaching, rather than starting a gateway of our own: the scripted gateway fixture
// serves a home's control socket and /api/ws, and bridges each connection to the same
// scripts the stdio fake runs. The launcher points nowhere, so anything that fell back
// to starting a child would fail loudly instead of quietly passing.
const gatewayScript = path.join(import.meta.dirname, "..", "fixtures", "fake-hermes-gateway.mjs");
chmodSync(gatewayScript, 0o755);

let home: string;
let project: string;
let state: string;
let gateway: ChildProcess | null = null;
let adapter: HermesAdapter;
const savedHome = process.env.HERMES_HOME;
const savedState = process.env.FAKE_HERMES_STATE;

beforeEach(async () => {
  home = tempDir("awui-hermes-gateway-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      spawns: [],
      rows: [{ id: "20261002_120000_fake1", title: "Fake Hermes session", cwd: project, last_active: 1790921090, message_count: 3 }],
    }),
  );
  process.env.HERMES_HOME = home;
  process.env.FAKE_HERMES_STATE = state;
  adapter = new HermesAdapter({ launcher: path.join(home, "no-such-hermes") });
  gateway = spawn(process.execPath, [gatewayScript, home], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    gateway?.stdout?.once("data", () => resolve());
    setTimeout(() => reject(new Error("the scripted gateway did not start")), 8_000);
  });
});

afterEach(async () => {
  await adapter.shutdown();
  gateway?.kill("SIGKILL");
  gateway = null;
  expect(liveHermesLinks()).toBe(0);
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  if (savedState === undefined) delete process.env.FAKE_HERMES_STATE;
  else process.env.FAKE_HERMES_STATE = savedState;
});

describe("a Hermes home whose gateway is running", () => {
  it("reads availability and the version from the gateway itself, with no CLI to fall back on", async () => {
    const found = await adapter.discover();
    expect(found).toMatchObject({ available: true, version: "1.2.3", versionDetail: "1.2.3 · gateway fakesha1" });
    // The owner is named, and the one thing it cannot serve here is said plainly.
    expect(found.warnings).toEqual([
      "a Hermes gateway serves this home over its newer session protocol: awui reads its sessions and models from there, but a chat needs that gateway stopped",
    ]);
    expect(liveHermesLinks()).toBe(0);
  });

  it("reads session rows through the attachment", async () => {
    const rows = await adapter.listRecentSessions(5);
    expect(rows.map((row) => row.nativeId)).toEqual(["20261002_120000_fake1"]);
    expect(rows[0]).toMatchObject({ title: "Fake Hermes session", cwd: project });
    // One short-lived attachment per read, and nothing of ours left behind.
    expect(liveHermesLinks()).toBe(0);
  });

  it("reads a project's sessions and its models over the attachment", async () => {
    expect((await adapter.listSessions(project)).map((row) => row.nativeId)).toEqual(["20261002_120000_fake1"]);
    expect((await adapter.listModels(project, true)).map((model) => model.key)).toEqual(["fake/fake-model", "fake/fake-mini"]);
    expect(liveHermesLinks()).toBe(0);
  });

  it("refuses a chat with the reason, instead of letting a doomed child exit", async () => {
    // The launcher points nowhere: reaching it at all would be the bug.
    await expect(adapter.openChat({ cwd: project })).rejects.toThrow(
      "a Hermes gateway serves this home over its newer session protocol: awui reads its sessions and models from there, but a chat needs that gateway stopped",
    );
    expect(liveHermesLinks()).toBe(0);
  });
});
