import { useState } from "react";
import type { ChatState } from "../chat-state.js";
import type { ToolsMode } from "../../shared/protocol.js";
import { Dialog } from "./Dialog.js";

export function Controls({
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

  return (
    <div className="controls" aria-label="Chat settings">
      {caps.supportsModelSelection ? (
        <label className="control">
          <span className="control-label">Model</span>
          <select
            className="select"
            value={config.model ?? ""}
            disabled={!idle || config.models.length === 0}
            onChange={(e) => void onConfig({ model: e.target.value })}
          >
            {!modelKnown ? <option value={config.model ?? ""}>{config.model ?? "No model"}</option> : null}
            {config.models.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name === m.id ? m.key : `${m.name} (${m.provider})`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {caps.supportsThinkingLevel && config.thinkingLevels.length > 0 ? (
        <label className="control">
          <span className="control-label">Thinking</span>
          <select
            className="select"
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
        </label>
      ) : null}
      {caps.supportsReadOnlyTools ? (
        <div className="control" role="group" aria-label="Tools">
          <span className="control-label">Tools</span>
          <div className="segmented">
            <button
              type="button"
              className={config.toolsMode === "readOnly" ? "is-active" : ""}
              aria-pressed={config.toolsMode === "readOnly"}
              disabled={!idle}
              onClick={() => config.toolsMode !== "readOnly" && void onConfig({ toolsMode: "readOnly" })}
            >
              Read-only
            </button>
            <button
              type="button"
              className={config.toolsMode === "full" ? "is-active is-danger" : ""}
              aria-pressed={config.toolsMode === "full"}
              disabled={!idle}
              onClick={() => config.toolsMode !== "full" && setConfirmFull(true)}
            >
              Full
            </button>
          </div>
        </div>
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
