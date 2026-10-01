import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/server/harness/fake.js";

describe("fake adapter history", () => {
  it("keeps the finished reply after dispose and resume", async () => {
    const adapter = new FakeAdapter({ chunkDelayMs: 1 });
    const live = await adapter.openChat({ cwd: "/p", toolsMode: "readOnly" });
    let settled = false;
    live.subscribe((e) => {
      if (e.type === "settled") settled = true;
    });
    await live.prompt("remember me");
    while (!settled) await new Promise((r) => setTimeout(r, 5));
    await live.dispose();
    const resumed = await adapter.openChat({ cwd: "/p", toolsMode: "readOnly", resumeNativeId: live.nativeId as string });
    const items = await resumed.history();
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(items[1]).toMatchObject({ text: expect.stringContaining("Echo: remember me") });
  });
});
