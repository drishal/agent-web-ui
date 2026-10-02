// Model and thinking live inside the composer card's bottom row (DeepSeek
// Harness). Tools are never narrowed: each harness keeps its normal tool set.
import type { ChatState } from "../chat-state.js";
import { IconChevronDown } from "../icons.js";
import { ModelPicker } from "./ModelPicker.js";

export function ComposerControls({
  chat,
  onConfig,
  onRefreshModels,
}: {
  chat: ChatState;
  onConfig: (patch: { model?: string; thinkingLevel?: string }) => Promise<void>;
  onRefreshModels: () => Promise<void>;
}) {
  const caps = chat.capabilities;
  const idle = chat.status === "idle" || chat.status === "error";
  const { config } = chat;

  return (
    <div className="composer-controls">
      {caps.supportsModelSelection ? (
        <ModelPicker
          models={config.models}
          current={config.model}
          harnessId={chat.harnessId}
          disabled={!idle}
          onSelect={(model) => void onConfig({ model })}
          onRefresh={onRefreshModels}
        />
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
