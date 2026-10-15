import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHerdrReporter, herdrPane, paneReport, resumeArgv } from "../../src/atui/herdr.js";
import { Herdr, herdrRequest, herdrSocketPath, paneSessionId, panesFrom } from "../../src/server/herdr.js";
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../../src/shared/protocol.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";
import { startFakeHerdr } from "../helpers/fake-herdr.js";

/** The stand-in herdr on a socket of its own, listing `agents`. */
async function fakeHerdr(agents: unknown[]) {
  const socket = path.join(tempDir("awui-herdr-"), "herdr.sock");
  const h = await startFakeHerdr(socket, () => agents);
  return { socket, ...h };
}

const pane = (over: Record<string, unknown>) => ({ pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", agent: "fake", agent_status: "working", ...over });

describe("herdr's panes", () => {
  it("name a session by id, or by the session file Pi and omp report", () => {
    const [byId, byPath, ours, bare] = panesFrom({
      agents: [
        pane({ agent: "claude", agent_session: { kind: "id", value: "9ed9c495", source: "herdr:claude" } }),
        pane({ agent: "pi", agent_session: { kind: "path", value: "/h/.pi/agent/sessions/--w--/2026-10-15T16-47-45-505Z_01a14076-6d61.jsonl", source: "herdr:pi" } }),
        pane({ agent: "claude", agent_session: { kind: "id", value: "abc", source: "awui:atui" } }),
        pane({ agent: "codex", agent_status: "sleeping" }),
      ],
    });
    expect(paneSessionId(byId!)).toBe("claude:9ed9c495");
    expect(paneSessionId(byPath!)).toBe("pi:01a14076-6d61");
    // atui's own report is awui's chat, not a second writer.
    expect(paneSessionId(ours!)).toBeNull();
    expect(bare).toMatchObject({ agent: "codex", status: "unknown", session: null });
    expect(panesFrom(null)).toEqual([]);
  });

  it("are asked of the pane's own herdr, else config.yml's socket, else the default session's", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/run/h.sock" }, "/home/u", "~/x.sock")).toBe("/run/h.sock");
    expect(herdrSocketPath({}, "/home/u", "~/x.sock")).toBe("/home/u/x.sock");
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe("/cfg/herdr/herdr.sock");
  });

  it("are none, quietly, when herdr is not running or the setting is off", async () => {
    const missing = path.join(tempDir("awui-herdr-"), "none.sock");
    await expect(herdrRequest(missing, "agent.list")).rejects.toMatchObject({ code: "not_running" });
    expect(await new Herdr(missing, () => true).panes()).toEqual([]);
    const h = await fakeHerdr([pane({})]);
    try {
      expect(await new Herdr(h.socket, () => false).panes()).toEqual([]);
      expect(h.calls).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe("sessions open in herdr", () => {
  let t: TestApp | null = null;
  let h: Awaited<ReturnType<typeof fakeHerdr>> | null = null;
  let on = true;
  afterEach(async () => {
    await t?.close();
    await h?.close();
    t = null;
    h = null;
    on = true;
  });

  async function setup() {
    h = await fakeHerdr([pane({ agent_session: { kind: "id", value: "s1", source: "herdr:fake" } })]);
    t = await makeTestApp({ herdr: new Herdr(h.socket, () => on) });
    t.fake.sessions.set("s1", { nativeId: "s1", cwd: t.project, title: "In a pane", messages: [{}], updatedAt: new Date() });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project }).expect(200)).body as WorkspaceInfo;
    const listed = async () =>
      ((await agent.get(`/api/sessions?path=${encodeURIComponent(t!.project)}`).expect(200)).body as SessionsOverview).sessions.find((s) => s.id === "fake:s1") as ProjectSession;
    return { agent, ws, listed };
  }

  it("are marked in the list with their pane and what herdr says it does", async () => {
    const { listed } = await setup();
    expect((await listed()).herdr).toEqual({ paneId: "w1:p2", status: "working" });
    on = false;
    await new Promise((r) => setTimeout(r, 1100));
    expect((await listed()).herdr).toBeUndefined();
  });

  it("are not resumed here unless asked to anyway, which would be a second writer", async () => {
    const { agent, ws } = await setup();
    const resume = { harnessId: "fake", workspaceId: ws.id, sessionId: "fake:s1" };
    const refused = await agent.post("/api/chats/resume").send(resume).expect(409);
    expect(refused.body).toMatchObject({ code: "open_in_herdr" });
    expect(refused.body.error).toContain("w1:p2");
    expect(t!.manager.list()).toHaveLength(0);
    await agent
      .post("/api/chats/resume")
      .send({ ...resume, ignoreHerdr: true })
      .expect(200);
  });

  it("are shown in herdr from this machine", async () => {
    const { agent } = await setup();
    await agent.post("/api/herdr/focus").send({ paneId: "w1:p2" }).expect(200);
    expect(h!.calls.at(-1)).toEqual({ method: "agent.focus", params: { target: "w1:p2" } });
    expect((await agent.post("/api/herdr/focus").send({ paneId: "w9:p9" }).expect(422)).body.code).toBe("herdr_failed");
    await agent.post("/api/herdr/focus").send({ paneId: "w1:p2; rm" }).expect(400);
    on = false;
    await agent.post("/api/herdr/focus").send({ paneId: "w1:p2" }).expect(404);
  });
});

describe("atui in a herdr pane", () => {
  const chat = (over: Partial<Parameters<typeof paneReport>[0] & object> = {}) => ({ status: "idle", pending: [], title: "Fix the build", sessionId: "claude:s1", harnessId: "claude", ...over });

  it("finds its pane as herdr's own hooks do", () => {
    expect(herdrPane({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toEqual({ socket: "/s", paneId: "w1:p1" });
    expect(herdrPane({ HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toBeNull();
  });

  it("reports blocked while a chat asks, working while one runs, else idle", () => {
    const none = { busy: 0, asking: 0 };
    expect(paneReport(chat(), none)).toEqual({ state: "idle", message: null, title: "Fix the build", sessionId: "claude:s1", harness: "claude" });
    expect(paneReport(chat({ status: "running" }), none).state).toBe("working");
    expect(paneReport(chat(), { busy: 1, asking: 0 }).state).toBe("working");
    expect(paneReport(chat({ status: "running", pending: [{ title: "Allow bash?\x1b]0;x" }] }), none)).toMatchObject({ state: "blocked", message: "Allow bash? ]0;x" });
    expect(paneReport(chat(), { busy: 0, asking: 2 })).toMatchObject({ state: "blocked", message: "2 chats need you" });
    expect(paneReport(null, none)).toMatchObject({ state: "idle", title: "New chat", sessionId: null });
  });

  it("offers a resume command only when atui is on PATH, naming a server that is not the default", () => {
    expect(resumeArgv(null, "http://a", "http://a", "pi:1")).toBeNull();
    expect(resumeArgv("atui", "http://a", "http://a", "pi:1")).toEqual(["atui", "--resume", "pi:1"]);
    expect(resumeArgv("atui", "http://b:9", "http://a", "pi:1")).toEqual(["atui", "--url", "http://b:9", "--resume", "pi:1"]);
  });

  it("sends the state, then the title, then the session once the pane is held, and skips repeats", async () => {
    const h = await fakeHerdr([]);
    try {
      const reporter = createHerdrReporter({ socket: h.socket, paneId: "w1:p1" }, { resume: (id) => ["atui", "--resume", id] });
      reporter.report(paneReport(chat({ status: "running" }), { busy: 0, asking: 0 }));
      await new Promise((r) => setTimeout(r, 100));
      reporter.report(paneReport(chat({ status: "running" }), { busy: 0, asking: 0 }));
      reporter.report(paneReport(chat(), { busy: 0, asking: 0 }));
      await new Promise((r) => setTimeout(r, 100));
      expect(h.calls.map((c) => c.method)).toEqual(["pane.report_agent", "pane.report_metadata", "pane.report_agent_session", "pane.report_agent"]);
      expect(h.calls[0]?.params).toMatchObject({ pane_id: "w1:p1", source: "awui:atui", agent: "awui", state: "working" });
      expect(h.calls[1]?.params).toMatchObject({ title: "Fix the build", display_agent: "atui · claude" });
      expect(h.calls[2]?.params).toMatchObject({ agent_session_id: "claude:s1", resume_argv: ["atui", "--resume", "claude:s1"] });
      expect(h.calls[3]?.params).toMatchObject({ state: "idle" });
      const seqs = h.calls.map((c) => c.params.seq as number);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    } finally {
      await h.close();
    }
  });
});
