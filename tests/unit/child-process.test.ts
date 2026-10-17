import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { StderrTail, stderrReason } from "../../src/server/harness/child-process.js";

describe("what a harness child said before it died", () => {
  it("keeps the last few lines, without a spinner's escapes, bounded", () => {
    expect(stderrReason("one\ntwo\nthree\nfour\n")).toBe("two three four");
    expect(stderrReason("\u001b[2K\u001b[1Grefused: /home/u/.hermes is owned by a running gateway\n")).toBe("refused: /home/u/.hermes is owned by a running gateway");
    expect(stderrReason("   \n\n")).toBeNull();
    expect(stderrReason("x".repeat(500), 3, 100)).toHaveLength(100);
    expect(stderrReason("first\nsecond", 1)).toBe("second");
  });

  it("reads a child's stderr as it arrives", async () => {
    const child = spawn(process.execPath, ["-e", 'process.stderr.write("first\\nsecond\\n"); process.exit(1)'], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = new StderrTail(child);
    await new Promise((done) => child.once("exit", done));
    // The tail is read when the exit is handled, so a child that prints and dies at once still has a reason.
    expect(stderr.reason()).toBe("first second");
  });

  it("forgets the oldest output once the tail is full", async () => {
    const child = spawn(process.execPath, ["-e", 'process.stderr.write("A".repeat(50) + "\\n" + "REASON\\n"); process.exit(1)'], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = new StderrTail(child, 20);
    await new Promise((done) => child.once("exit", done));
    const reason = stderr.reason() ?? "";
    expect(reason).toMatch(/^A+ REASON$/);
    // Fifty A's were written; the 20-character tail is all that is kept of them.
    expect(reason.length).toBeLessThan(25);
  });
});
