import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol.js";
import { retryLabel, retryMode, retryPrompt } from "../../src/web/tool-retry.js";

const failed: ToolItem = {
  kind: "tool",
  id: "t",
  name: "bash",
  args: JSON.stringify({ command: "npm run e2e" }),
  status: "error",
  output: "\nError: port 4791 is already in use\n    at Server.setupListenHandle",
  truncated: false,
  category: "command",
  summary: "npm run e2e",
  paths: [],
};

describe("retryPrompt", () => {
  it("names the call and the error's first line", () => {
    expect(retryPrompt(failed)).toBe("Retry the failed tool call (running npm run e2e). It failed with: Error: port 4791 is already in use");
  });
  it("words a file call with the project-relative path", () => {
    const read: ToolItem = { ...failed, name: "read", category: "read", args: "{}", paths: ["/p/src/a.ts"], output: "ENOENT" };
    expect(retryPrompt(read, "/p")).toBe("Retry the failed tool call (reading src/a.ts). It failed with: ENOENT");
  });
  it("leaves out the error when the call left none", () => {
    expect(retryPrompt({ ...failed, output: "" })).toBe("Retry the failed tool call (running npm run e2e).");
  });
});

describe("retryLabel", () => {
  it("says which call it asks about", () => {
    expect(retryLabel(failed)).toBe("Ask the agent to retry running npm run e2e");
  });
});

describe("retryMode", () => {
  it("sends when idle, queues when the harness takes follow-ups, else waits", () => {
    expect(retryMode("idle", false)).toBe("send");
    expect(retryMode("error", false)).toBe("send");
    expect(retryMode("running", true)).toBe("queue");
    expect(retryMode("running", false)).toBe("blocked");
    expect(retryMode("stopping", false)).toBe("blocked");
  });
  it("offers nothing for a chat that is gone", () => {
    expect(retryMode("disposed", true)).toBeNull();
  });
});
