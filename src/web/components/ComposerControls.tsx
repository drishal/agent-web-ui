// Model and thinking live inside the composer card's bottom row (DeepSeek
// Harness). Tools are never narrowed: each harness keeps its normal tool set.
import type { ChatState } from "../chat-state.js";
import { IconChevronDown } from "../icons.js";

function shortModel(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

export function ComposerControls({
  chat,
  onConfig,
}: {
  chat: ChatState;
  onConfig: (patch: { model?: string; thinkingLevel?: string }) => Promise<void>;
}) {
  const caps = chat.capabilities;
  const idle = chat.status === "idle" || chat.status === "error";
  const { config } = chat;
  const modelKnown = config.model !== null && config.models.some((m) => m.key === config.model);

  return (
    <div className="composer-controls">
      {caps.supportsModelSelection ? (
        <label className="pill-select">
          <select
            aria-label="Model"
            value={config.model ?? ""}
            disabled={!idle || config.models.length === 0}
            onChange={(e) => void onConfig({ model: e.target.value })}
          >
            {!modelKnown ? <option value={config.model ?? ""}>{config.model ?? "No model"}</option> : null}
            {config.models.map((m) => (
              <option key={m.key} value={m.key}>
                {shortModel(m.name === m.id ? m.key : m.name)}
              </option>
            ))}
          </select>
          <IconChevronDown size={12} />
        </label>
      ) : null}
      {caps.supportsThinkingLevel && config.thinkingLevels.length > 0 ? (
        <label className="pill-select">
          <select
            aria-label="Thinking"
            value={config.thinkingLevel ?? ""}
            disabled={!idle}
            onChange={(e) => void onConfig({ thinkingLevel: e.target.value })}
          >
            {config.thinkingLevels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <IconChevronDown size={12} />
        </label>
      ) : null}
    </div>
  );
}
