// Model and thinking live inside the composer card's bottom row (DeepSeek
// Harness). Tools are never narrowed: each harness keeps its normal tool set.
import { useState } from "react";
import type { ChatState } from "../chat-state.js";
import type { HarnessStatus } from "../../shared/protocol.js";
import { IconChevronDown } from "../icons.js";
import { HarnessMenu } from "./HarnessMenu.js";
import { ModelPicker } from "./ModelPicker.js";

/**
 * A handoff target: a harness that keeps past turns gets a copy of the
 * conversation; any other continues from a summary sent as its first prompt.
 */
function handoffChoice(h: HarnessStatus) {
  if (!h.available) return { harness: h, blocked: h.reason ?? "Not available" };
  return { harness: h, blocked: null, note: h.capabilities.supportsHandoff ? "Copies the conversation" : "Continues from a summary" };
}

/**
 * The composer's harness chip: the chat's harness, and a menu of the others to
 * hand it off to. It stays disabled while a handoff runs (one POST, one new
 * session); success navigates away, failure re-enables it.
 */
function HandoffChip({ chat, harnesses, onHandoff }: { chat: ChatState; harnesses: HarnessStatus[]; onHandoff: (harnessId: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const choices = harnesses.filter((h) => h.id !== chat.harnessId).map(handoffChoice);
  const current = harnesses.find((h) => h.id === chat.harnessId);
  return (
    <HarnessMenu
      variant="chip"
      label="Hand off to another harness"
      menuLabel="Hand off to"
      currentId={chat.harnessId}
      choices={current ? [{ harness: current, blocked: "This chat's harness" }, ...choices] : choices}
      triggerText={pending ? "Handing off…" : undefined}
      disabled={pending || chat.status === "disposed" || choices.every((c) => c.blocked !== null)}
      onPick={(id) => {
        if (id === chat.harnessId) return;
        setPending(true);
        void onHandoff(id).finally(() => setPending(false));
      }}
    />
  );
}

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
  onHandoff: (harnessId: string) => Promise<void>;
}) {
  const caps = chat.capabilities;
  const idle = chat.status === "idle" || chat.status === "error";
  const { config } = chat;

  return (
    <div className="composer-controls">
      <HandoffChip chat={chat} harnesses={harnesses} onHandoff={onHandoff} />
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
