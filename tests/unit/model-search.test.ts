import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../src/shared/protocol.js";
import { groupModels, matchRank } from "../../src/web/model-search.js";

const m = (provider: string, id: string, name: string): ModelInfo => ({ key: `${provider}/${id}`, provider, id, name });
const MODELS = [
  m("opencode-go", "gpt-5.5", "GPT-5.5"),
  m("opencode-go", "gpt-5.6-luna", "GPT-5.6-Luna"),
  m("opencode-go", "glm-5.3-flash", "GLM-5.3-Flash"),
  m("xai-oauth", "grok-4.7", "Grok 4.7"),
  m("local2", "GLM5", "GLM5"),
  m("opencode-go", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
];

describe("model search", () => {
  it("ignores punctuation and spacing (gpt55 finds GPT-5.5)", () => {
    expect(matchRank("gpt55", MODELS[0] as ModelInfo)).toBe(0);
    expect(matchRank("glm 5.3", MODELS[2] as ModelInfo)).toBe(0);
    expect(matchRank("nope", MODELS[0] as ModelInfo)).toBeNull();
  });

  it("matches word starts, provider, and multi-word queries", () => {
    expect(matchRank("flash", MODELS[5] as ModelInfo)).toBe(1);
    expect(matchRank("xai", MODELS[3] as ModelInfo)).toBe(3);
    expect(matchRank("deepseek flash", MODELS[5] as ModelInfo)).not.toBeNull();
    expect(matchRank("local2 glm", MODELS[4] as ModelInfo)).not.toBeNull();
  });

  it("groups by provider: current provider first, then best match", () => {
    const all = groupModels(MODELS, "", "xai-oauth/grok-4.7");
    expect(all.map((g) => g.provider)).toEqual(["xai-oauth", "local2", "opencode-go"]);
    expect(all[2]?.models.map((x) => x.name)).toEqual(["DeepSeek V4.1 Flash", "GLM-5.3-Flash", "GPT-5.5", "GPT-5.6-Luna"]);
    const glm = groupModels(MODELS, "glm", null);
    expect(glm.flatMap((g) => g.models.map((x) => x.key))).toEqual(["local2/GLM5", "opencode-go/glm-5.3-flash"]);
    expect(groupModels(MODELS, "zzz", null)).toEqual([]);
  });
});
