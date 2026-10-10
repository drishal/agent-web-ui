// The awui harness's own settings: the providers it can call, read from and
// written to its isolated agent dir's models.json — never the user's real
// ~/.pi/agent. These routes edit that file only; a live awui chat picks a
// changed provider set up on its next model refresh, and existing chats keep
// the model they started with.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HarnessRegistry } from "./harness/registry.js";
import { ChatError } from "./chats/chat.js";

// apiKey is optional: providers behind no auth (a local llama server) omit it.
const awuiProviderSchema = z.object({
  baseUrl: z.string().max(2048).regex(/^https?:\/\//, "needs an http(s) URL"),
  api: z.string().min(1).max(64),
  apiKey: z.string().max(512).optional(),
  modelOverrides: z.record(z.string(), z.unknown()).optional(),
});
const awuiSettingsPatchSchema = z
  .object({
    providers: z.record(z.string().min(1).max(64), awuiProviderSchema),
  })
  .strict();

export interface AwuiProvider {
  baseUrl: string;
  api: string;
  /** Present only in the read-bytes shape; never returned to the browser. */
  apiKey?: string;
  modelOverrides?: Record<string, unknown>;
}

interface AwuiModelsFile {
  providers?: Record<string, AwuiProvider>;
}

async function readModelsFile(agentDir: string): Promise<AwuiModelsFile> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as AwuiModelsFile) : {};
  } catch {
    return {};
  }
}

/** The awui adapter's agent dir, or null when the harness is not registered. */
function agentDirFor(registry: HarnessRegistry): Promise<string> | null {
  const adapter = registry.get("awui");
  return adapter ? adapter.resolveAgentDir() : null;
}

/**
 * The providers as the settings dialog shows them: apiKeys redacted to a
 * boolean so the form can say "key set" without the key ever leaving the
 * server (peer to how the login password is write-only).
 */
export async function readAwuiConfig(registry: HarnessRegistry): Promise<{ providers: Record<string, { baseUrl: string; api: string; hasApiKey: boolean; modelOverrides?: Record<string, unknown> }> }> {
  const agentDir = agentDirFor(registry);
  if (!agentDir) throw new ChatError(404, "no_awui_harness", "The awui harness is not enabled");
  const file = await readModelsFile(await agentDir);
  const providers: Record<string, { baseUrl: string; api: string; hasApiKey: boolean; modelOverrides?: Record<string, unknown> }> = {};
  for (const [name, p] of Object.entries(file.providers ?? {})) {
    providers[name] = { baseUrl: p.baseUrl, api: p.api, hasApiKey: Boolean(p.apiKey), ...(p.modelOverrides !== undefined ? { modelOverrides: p.modelOverrides } : {}) };
  }
  return { providers };
}

/**
 * Replace the providers. An omitted apiKey keeps the stored one (the dialog's
 * leave-it-blank convention); an empty string clears it. Writes whole-file
 * through temp + rename, mode 0600 (it carries keys).
 */
export async function writeAwuiConfig(registry: HarnessRegistry, body: unknown): Promise<{ providers: Record<string, { baseUrl: string; api: string; hasApiKey: boolean }> }> {
  const agentDirPromise = agentDirFor(registry);
  if (!agentDirPromise) throw new ChatError(404, "no_awui_harness", "The awui harness is not enabled");
  const patch = awuiSettingsPatchSchema.parse(body);
  const agentDir = await agentDirPromise;
  const existing = await readModelsFile(agentDir);
  const merged: Record<string, AwuiProvider> = {};
  for (const [name, p] of Object.entries(patch.providers)) {
    const prior = existing.providers?.[name];
    // apiKey tri-state: undefined (dialog left it blank) keeps the stored
    // key; "" clears it; anything else replaces it.
    merged[name] = {
      baseUrl: p.baseUrl,
      api: p.api,
      ...(p.apiKey === undefined ? (prior?.apiKey !== undefined ? { apiKey: prior.apiKey } : {}) : p.apiKey === "" ? {} : { apiKey: p.apiKey }),
      ...(p.modelOverrides !== undefined ? { modelOverrides: p.modelOverrides } : {}),
    };
  }
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  const target = path.join(agentDir, "models.json");
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ providers: merged }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, target);
  return readAwuiConfig(registry);
}
