import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatState } from "../chat-state.js";
import type { InteractionAnswer, SendMode } from "../../shared/protocol.js";
import { load, save } from "../storage.js";
import { RequestCard } from "./RequestCard.js";

const coarsePointer = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export function Composer({
  chat,
  maxChars,
  onSend,
  onStop,
  onAnswer,
}: {
  chat: ChatState;
  maxChars: number;
  onSend: (text: string, mode: SendMode) => Promise<boolean>;
  onStop: () => void;
  onAnswer: (requestId: string, answer: InteractionAnswer) => Promise<void>;
}) {
  const draftKey = `draft.${chat.chatId}`;
  const [text, setText] = useState(() => load<string>(draftKey, ""));
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const caps = chat.capabilities;
  const running = chat.status === "running";
  const stopping = chat.status === "stopping";
  const busy = running || stopping || chat.status === "compacting";
  const closed = chat.status === "disposed";
  const pending = chat.pending[0];

  useEffect(() => {
    setText(load<string>(draftKey, ""));
  }, [draftKey]);

  useEffect(() => {
    save(draftKey, text);
  }, [draftKey, text]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = useCallback(
    async (mode: SendMode) => {
      const value = text.trim();
      if (!value || sending) return;
      // Clear immediately so text typed while the request is in flight survives;
      // restore only if the send failed and nothing new was typed.
      setSending(true);
      setText("");
      const ok = await onSend(value, mode);
      setSending(false);
      if (!ok) setText((current) => current || value);
      area.current?.focus();
    },
    [onSend, sending, text],
  );

  const primaryMode: SendMode = busy ? (caps.supportsSteer ? "steer" : "stopAndSend") : "normal";

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || coarsePointer()) return;
    e.preventDefault();
    if (!busy) void submit("normal");
    else if (caps.supportsSteer && running) void submit("steer");
  };

  if (pending && !closed) {
    return (
      <div className="composer composer-request">
        <RequestCard
          key={pending.id}
          request={pending}
          busy={answering}
          onAnswer={async (answer) => {
            setAnswering(true);
            await onAnswer(pending.id, answer);
            setAnswering(false);
          }}
        />
        {chat.pending.length > 1 ? <p className="composer-hint">{chat.pending.length - 1} more waiting</p> : null}
        <div className="composer-row">
          <button type="button" className="btn btn-danger" onClick={onStop} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        </div>
      </div>
    );
  }

  const queued = [...chat.queue.steering.map((t) => ({ t, k: "Steering" })), ...chat.queue.followUp.map((t) => ({ t, k: "Queued" }))];
  const tooLong = text.length > maxChars;

  return (
    <div className="composer">
      {queued.length > 0 ? (
        <ul className="queue" aria-label="Queued messages">
          {queued.map((q, i) => (
            <li key={`${q.k}${i}`} className="queue-chip">
              <span className="queue-kind">{q.k}</span>
              <span className="queue-text">{q.t}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="composer-box">
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          disabled={closed}
          placeholder={closed ? "This chat is closed" : busy ? (caps.supportsSteer ? "Steer the agent, or queue a follow-up…" : "The agent is working…") : "Message the agent…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message"
          enterKeyHint={coarsePointer() ? "enter" : "send"}
        />
        <div className="composer-row">
          {tooLong ? <span className="composer-hint is-error">Too long ({text.length.toLocaleString()} / {maxChars.toLocaleString()})</span> : <span className="composer-hint">{busy ? statusHint(chat.status) : ""}</span>}
          <div className="composer-buttons">
            {busy ? (
              <>
                {caps.supportsSteer ? (
                  <button type="button" className="btn" disabled={!text.trim() || sending || !running || tooLong} onClick={() => void submit("steer")}>
                    Steer
                  </button>
                ) : null}
                {caps.supportsFollowUp ? (
                  <button type="button" className="btn" disabled={!text.trim() || sending || !running || tooLong} onClick={() => void submit("followUp")}>
                    Follow-up
                  </button>
                ) : null}
                {!caps.supportsSteer ? (
                  <button type="button" className="btn" disabled={!text.trim() || sending || stopping || tooLong} onClick={() => void submit("stopAndSend")}>
                    Stop and send
                  </button>
                ) : null}
                <button type="button" className="btn btn-danger" onClick={onStop} disabled={stopping} aria-label="Stop the agent">
                  {stopping ? "Stopping…" : "Stop"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!text.trim() || sending || closed || tooLong}
                onClick={() => void submit(primaryMode)}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusHint(status: ChatState["status"]): string {
  switch (status) {
    case "running":
      return "Working…";
    case "stopping":
      return "Stopping…";
    case "compacting":
      return "Compacting…";
    default:
      return "";
  }
}
