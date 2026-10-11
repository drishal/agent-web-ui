// The one-line summary a tool row shows for a call. The fallback for a shape
// the summarizer does not recognize was a minified JSON blob; now it formats
// keys and values readably. Known shapes (a command, a path, a URL) still win.
import { describe, expect, it } from "vitest";
import { toolSummary } from "../../src/server/harness/agent-events.js";

describe("toolSummary", () => {
  it("formats an unknown object call readably instead of minified JSON", () => {
    expect(toolSummary({ char_limit: 15000, urls: ["https://www.rtings.com/x"] }))
      .toBe("char_limit: 15000, urls: [https://www.rtings.com/x]");
  });

  it("keeps command and URL summaries ahead of the generic shape", () => {
    expect(toolSummary({ command: "npm test" })).toBe("npm test");
    expect(toolSummary({ url: "https://example.com/x" })).toBe("https://example.com/x");
    expect(toolSummary({ path: "src/app.ts" })).toBe("src/app.ts");
  });

  it("bounds a long value to the one-line budget", () => {
    const long = toolSummary({ body: "x".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(160);
  });
});
