// Model, thinking, and tools live inside the composer card's bottom row
// (DeepSeek Harness), instead of a separate settings strip.
import { useState } from "react";
import type { ToolsMode } from "../../shared/protocol.js";
import type { ChatState } from "../chat-state.js";
import { IconChevronDown, IconLock, IconUnlock } from "../icons.js";
import { Dialog } from "./Dialog.js";

function shortModel(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

export function ComposerControls({
  chat,
  onConfig,
}: {
  chat: ChatState;
  onConfig: (patch: { model?: string; thinkingLevel?: string; toolsMode?: ToolsMode }) => Promise<void>;
}) {
  const [confirmFull, setConfirmFull] = useState(false);
  const caps = chat.capabilities;
  const idle = chat.status === "idle" || chat.status === "error";
  const { config } = chat;
  const modelKnown = config.model !== null && config.models.some((m) => m.key === config.model);
  const full = config.toolsMode === "full";

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
      {caps.supportsReadOnlyTools ? (
        <button
          type="button"
          className={`pill-toggle${full ? " is-full" : ""}`}
          aria-label={`Tools: ${full ? "Full" : "Read-only"}`}
          aria-pressed={full}
          data-testid="tools-toggle"
          disabled={!idle}
          onClick={() => (full ? void onConfig({ toolsMode: "readOnly" }) : setConfirmFull(true))}
        >
          {full ? <IconUnlock size={13} /> : <IconLock size={13} />}
          <span>{full ? "Full" : "Read-only"}</span>
        </button>
      ) : null}
      {confirmFull ? (
        <Dialog title="Enable full tools?" onClose={() => setConfirmFull(false)}>
          <p>
            With full tools the agent can run shell commands and edit or delete files <strong>as you</strong>, in{" "}
            <code>{chat.workspace.path}</code> and anywhere else your user can reach.
          </p>
          <p className="muted">Read-only is a tool allowlist, not a sandbox. Neither mode isolates the agent from your system.</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirmFull(false)}>
              Keep read-only
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirmFull(false);
                void onConfig({ toolsMode: "full" });
              }}
            >
              Enable full tools
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
