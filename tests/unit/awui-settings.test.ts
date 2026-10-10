// The awui harness's provider settings: read from and written to its isolated
// agent dir's models.json, with the apiKey never returned to the browser.
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { AwuiAdapter } from "../../src/server/harness/awui.js";
import { readAwuiConfig, writeAwuiConfig } from "../../src/server/awui-settings.js";

function registryWith(): { registry: HarnessRegistry; agentDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), "awui-cfg-"));
  const registry = new HarnessRegistry();
  registry.register(new AwuiAdapter(stateDir));
  return { registry, agentDir: path.join(stateDir, "awui-agent") };
}

describe("awui harness settings", () => {
  it("reads providers with the apiKey redacted to a flag", async () => {
    const { registry } = registryWith();
    await writeAwuiConfig(registry, { providers: { litellm: { baseUrl: "http://h:1/v1", api: "openai-completions", apiKey: "sk-secret" } } });
    const read = await readAwuiConfig(registry);
    expect(read.providers.litellm).toMatchObject({ baseUrl: "http://h:1/v1", api: "openai-completions", hasApiKey: true });
    expect(JSON.stringify(read)).not.toContain("sk-secret");
  });

  it("keeps the stored key when the form leaves it blank, and clears it on an empty string", async () => {
    const { registry } = registryWith();
    await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:2/v1", api: "openai-completions", apiKey: "sk-first" } } });
    // Blank (omitted): keep.
    const kept = await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:2/v1", api: "openai-completions" } } });
    expect(kept.providers.local?.hasApiKey).toBe(true);
    // Empty string: clear.
    const cleared = await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:2/v1", api: "openai-completions", apiKey: "" } } });
    expect(cleared.providers.local?.hasApiKey).toBe(false);
  });

  it("writes the isolated agent dir's models.json with the key on disk", async () => {
    const { registry, agentDir } = registryWith();
    await writeAwuiConfig(registry, { providers: { litellm: { baseUrl: "http://h:3/v1", api: "openai-completions", apiKey: "sk-x" } } });
    const raw = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { apiKey?: string }> };
    expect(raw.providers.litellm?.apiKey).toBe("sk-x");
  });

  it("rejects a provider without an http(s) baseUrl", async () => {
    const { registry } = registryWith();
    await expect(writeAwuiConfig(registry, { providers: { bad: { baseUrl: "notaurl", api: "x" } } })).rejects.toThrow();
  });

  it("404s when the awui harness is not registered", async () => {
    const registry = new HarnessRegistry();
    await expect(readAwuiConfig(registry)).rejects.toMatchObject({ code: "no_awui_harness" });
  });
});
