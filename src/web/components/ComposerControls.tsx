// Model and thinking live inside the composer card's bottom row (DeepSeek
// Harness). Tools are never narrowed: each harness keeps its normal tool set.
import type { ChatState } from "../chat-state.js";
import type { HarnessStatus } from "../../shared/protocol.js";
import { IconChevronDown } from "../icons.js";
import { HarnessPicker } from "./HarnessPicker.js";
import { ModelPicker } from "./ModelPicker.js";

export function ComposerControls({
  chat,
  harnesses,
  onConfig,
  onRefreshModels,
  onHandoff,
}: {
  chat: ChatState;
  harnesses: HarnessStatus[];
  onConfig: (patch: { model?: string; thinkingLevel?: string }) => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onHandoff: (harnessId: string) => void;
}) {
  const caps = chat.capabilities;
  const idle = chat.status === "idle" || chat.status === "error";
  const { config } = chat;

  return (
    <div className="composer-controls">
      <HarnessPicker harnesses={harnesses} currentId={chat.harnessId} disabled={chat.status === "disposed"} onHandoff={onHandoff} />
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
