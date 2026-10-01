// Thin app-wide status bar (after Hermes Desktop): connection, harness and
// model, project, version. Desktop only; phones get a header banner instead.
import type { ChatState } from "../chat-state.js";
import type { ConnectionState } from "../stream.js";

const CONN_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

export function StatusBar({
  conn,
  chat,
  harnessName,
  version,
}: {
  conn: ConnectionState;
  chat: ChatState | null;
  harnessName: string | null;
  version: string;
}) {
  const model = chat?.config.models.find((m) => m.key === chat.config.model)?.name ?? chat?.config.model ?? null;
  return (
    <footer className="status-bar" aria-label="Status">
      {chat ? (
        <span className={`sb-item conn conn-${conn}`} data-testid="connection" aria-live="polite">
          {CONN_LABEL[conn]}
        </span>
      ) : (
        <span className="sb-item muted">No chat open</span>
      )}
      {chat && harnessName ? (
        <span className="sb-item">
          {harnessName}
          {model ? ` · ${model}` : ""}
          {chat.config.thinkingLevel ? ` · ${chat.config.thinkingLevel}` : ""}
        </span>
      ) : null}
      {chat ? <span className="sb-item sb-path" title={chat.workspace.path}>{chat.workspace.path}</span> : null}
      <span className="sb-spacer" />
      <span className="sb-item">v{version}</span>
    </footer>
  );
}
