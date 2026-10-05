import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/server/config.js";
import { boundText, historyToItems, normalizeAgentEvent, toolCategory, toolPaths, toolSummary } from "../../src/server/harness/agent-events.js";
import { buildOmpEnv } from "../../src/server/harness/omp.js";

describe("loadConfig", () => {
  it("defaults to 127.0.0.1:4783 and the home directory", () => {
    const c = loadConfig({ HOME: "/home/x" });
    expect(c.port).toBe(4783);
    expect(c.host).toBe("127.0.0.1");
    expect(c.harnesses).toEqual(["pi", "omp", "hermes", "claude"]);
  });

  it("binds 127.0.0.1 unless HOST=0.0.0.0, and rejects anything else", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    for (const bad of ["192.168.1.5", "::", "localhost"]) expect(() => loadConfig({ HOST: bad })).toThrow(ConfigError);
    expect(loadConfig({ XDG_STATE_HOME: "/st" }).credentialsFile).toBe("/st/agent-web-ui/credentials.json");
    expect(loadConfig({ AUTH_CREDENTIALS_FILE: "/run/secrets/awui" }).credentialsFile).toBe("/run/secrets/awui");
  });

  it("takes a login from AUTH_USERNAME/AUTH_PASSWORD, with set-password's rules", () => {
    expect(loadConfig({}).login).toBeNull();
    expect(loadConfig({ AUTH_USERNAME: "drishal", AUTH_PASSWORD: "" }).login).toBeNull();
    expect(loadConfig({ AUTH_USERNAME: " drishal ", AUTH_PASSWORD: "long enough" }).login).toEqual({
      username: "drishal",
      password: "long enough",
    });
    expect(() => loadConfig({ AUTH_PASSWORD: "long enough" })).toThrow(/AUTH_USERNAME/);
    expect(() => loadConfig({ AUTH_USERNAME: "two words", AUTH_PASSWORD: "long enough" })).toThrow(ConfigError);
    expect(loadConfig({ AUTH_USERNAME: "drishal", AUTH_PASSWORD: "short" }).login).toEqual({ username: "drishal", password: "short" });
  });

  it("validates PORT", () => {
    expect(loadConfig({ PORT: "5000" }).port).toBe(5000);
    for (const bad of ["80", "70000", "abc", "4783.5"]) expect(() => loadConfig({ PORT: bad })).toThrow(ConfigError);
  });

  it("normalizes ALLOWED_HOSTS and rejects junk", () => {
    expect(loadConfig({ ALLOWED_HOSTS: "Box.Tail.ts.net, other:8443" }).allowedHosts).toEqual(["box.tail.ts.net", "other:8443"]);
    expect(() => loadConfig({ ALLOWED_HOSTS: "http://x/y" })).toThrow(ConfigError);
  });

  it("splits WORKSPACE_ROOTS on the path delimiter and expands ~", () => {
    const c = loadConfig({ WORKSPACE_ROOTS: "/a:~/b" });
    expect(c.workspaceRoots[0]).toBe("/a");
    expect(c.workspaceRoots[1]?.endsWith("/b")).toBe(true);
    expect(c.workspaceRoots[1]?.startsWith("~")).toBe(false);
  });

  it("uses XDG dirs for theme and state", () => {
    const c = loadConfig({ XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/st" });
    expect(c.themeFile).toBe("/cfg/agentwebui/theme.yml");
    expect(c.themeFileExplicit).toBe(false);
    expect(c.stateDir).toBe("/st/agent-web-ui");
  });
});

describe("omp environment isolation", () => {
  it("strips Pi's overrides and maps omp's own onto omp's names", () => {
    const base = { PATH: "/bin", PI_CODING_AGENT_DIR: "/pi", PI_CODING_AGENT_SESSION_DIR: "/pi-s", OMP_AGENT_DIR: "/o" };
    expect(buildOmpEnv(base, null, null)).toEqual({ PATH: "/bin" });
    expect(buildOmpEnv(base, "/o", "/o-s")).toEqual({ PATH: "/bin", PI_CODING_AGENT_DIR: "/o", PI_CODING_AGENT_SESSION_DIR: "/o-s" });
  });
});

describe("agent event normalization", () => {
  it("maps streaming, tools, queue, and settle events", () => {
    expect(normalizeAgentEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hm" } }, "agent_settled")).toEqual([
      { type: "assistant_delta", field: "thinking", delta: "hm" },
    ]);
    expect(normalizeAgentEvent({ type: "tool_execution_end", toolCallId: "1", result: { content: [{ type: "text", text: "ok" }] }, isError: false }, "x")).toEqual([
      { type: "tool_end", toolCallId: "1", output: "ok", isError: false },
    ]);
    expect(normalizeAgentEvent({ type: "agent_settled" }, "agent_settled")).toEqual([{ type: "settled" }]);
    expect(normalizeAgentEvent({ type: "session_settled" }, "session_settled")).toEqual([{ type: "settled" }]);
    expect(normalizeAgentEvent({ type: "agent_end" }, "agent_settled")).toEqual([]);
    expect(normalizeAgentEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } }, "x")).toEqual([
      { type: "assistant_end", text: "", thinking: "", error: "boom" },
    ]);
  });

  it("rebuilds the active branch with tool results attached", () => {
    const items = historyToItems([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "data" }], isError: false },
      { role: "compactionSummary", summary: "s" },
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: {} }] },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "notice", "tool"]);
    expect(items[2]).toMatchObject({ status: "done", output: "data" });
    expect(items[4]).toMatchObject({ status: "error" });
  });

  it("categorizes tools for per-turn counts", () => {
    const cases: Record<string, string> = {
      read: "read", view: "read", edit: "edit", ast_edit: "edit", apply_patch: "edit", write: "write",
      bash: "command", eval: "command", grep: "search", glob: "search", find: "search", ast_grep: "search",
      ls: "search", web_search: "web", web_fetch: "web", ask: "other", todo: "other",
    };
    for (const [name, category] of Object.entries(cases)) expect(toolCategory(name), name).toBe(category);
  });

  it("summarizes calls by command, path, or query and lists paths", () => {
    expect(toolSummary({ command: "npm  test\n--watch" })).toBe("npm test --watch");
    expect(toolSummary({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolSummary({ paths: ["a", "b", "c"] })).toBe("a +2");
    expect(toolSummary({ pattern: "TODO" })).toBe("TODO");
    // Searches say what they look for, and where unless it is the working directory.
    expect(toolSummary({ pattern: "*.gguf", target: "files", path: "." })).toBe("*.gguf");
    expect(toolSummary({ pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolPaths({ pattern: "x", target: "content", path: "." })).toEqual(["."]);
    expect(toolPaths({ target: "docs/README.md" })).toEqual(["docs/README.md"]);
    expect(toolPaths({ file_path: "/x/y.ts", edits: [{ path: "z.ts" }, "w.ts"] })).toEqual(["/x/y.ts", "z.ts", "w.ts"]);
    expect(toolPaths("nope")).toEqual([]);
  });

  it("keeps harness timestamps on rebuilt history", () => {
    const items = historyToItems([
      { role: "user", content: "hi", timestamp: 1000 },
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "edit", arguments: { path: "f.ts" } }], timestamp: 2000 },
      { role: "toolResult", toolCallId: "c", content: [], isError: false, timestamp: 5000 },
    ]);
    expect(items[0]).toMatchObject({ at: 1000 });
    expect(items[1]).toMatchObject({ kind: "tool", category: "edit", summary: "f.ts", paths: ["f.ts"], at: 2000, endedAt: 5000 });
  });

  it("bounds text by keeping head and tail", () => {
    const b = boundText("a".repeat(10_000) + "b".repeat(10_000), 1000);
    expect(b.truncated).toBe(true);
    expect(b.text.length).toBeLessThan(1100);
    expect(b.text.startsWith("a")).toBe(true);
    expect(b.text.endsWith("b")).toBe(true);
  });
});
