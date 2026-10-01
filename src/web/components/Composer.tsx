// The composer card (DeepSeek Harness): text on top, settings and actions in
// the bottom row, a status stack above, approvals taking over the card.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { InteractionAnswer, SendMode, ToolsMode } from "../../shared/protocol.js";
import type { ChatState } from "../chat-state.js";
import { IconArrowUp, IconStop, Spinner } from "../icons.js";
import { load, save } from "../storage.js";
import { ApprovalStack } from "./ApprovalStack.js";
import { ComposerControls } from "./ComposerControls.js";
import { ContextRing } from "./ContextRing.js";
import { StatusStack } from "./StatusStack.js";

const coarsePointer = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export function Composer({
  chat,
  maxChars,
  hero,
  placeholder,
  onSend,
  onStop,
  onAnswer,
  onConfig,
}: {
  chat: ChatState;
  maxChars: number;
  hero?: boolean;
  placeholder?: string;
  onSend: (text: string, mode: SendMode) => Promise<boolean>;
  onStop: () => void;
  onAnswer: (requestId: string, answer: InteractionAnswer) => Promise<void>;
  onConfig: (patch: { model?: string; thinkingLevel?: string; toolsMode?: ToolsMode }) => Promise<void>;
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

  useEffect(() => {
    save(draftKey, text);
  }, [draftKey, text]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || coarsePointer()) return;
    e.preventDefault();
    if (!busy) void submit("normal");
    else if (caps.supportsSteer && running) void submit("steer");
  };

  const tooLong = text.length > maxChars;
  const empty = !text.trim();
  const pending = closed ? [] : chat.pending;

  return (
    <div className={`composer${hero ? " is-hero" : ""}`}>
      <StatusStack chatId={chat.chatId} queue={chat.queue} todos={chat.todos} extensionStatus={chat.extensionStatus} />
      {pending.length > 0 ? (
        <ApprovalStack
          pending={pending}
          busy={answering}
          stopping={stopping}
          onStop={onStop}
          onAnswer={async (request, answer) => {
            setAnswering(true);
            await onAnswer(request.id, answer);
            setAnswering(false);
          }}
        />
      ) : (
        <div className={`composer-card${closed ? " is-closed" : ""}`}>
          <textarea
            ref={area}
            className="composer-input"
            rows={hero ? 2 : 1}
            value={text}
            disabled={closed}
            placeholder={
              closed
                ? "This chat is closed"
                : busy
                  ? caps.supportsSteer
                    ? "Steer the agent, or queue a follow-up…"
                    : "The agent is working…"
                  : (placeholder ?? "Message the agent…")
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Message"
            enterKeyHint={coarsePointer() ? "enter" : "send"}
          />
          <div className="composer-bar">
            <ComposerControls chat={chat} onConfig={onConfig} />
            <div className="composer-actions">
              {tooLong ? (
                <span className="composer-error">
                  {text.length.toLocaleString()} / {maxChars.toLocaleString()}
                </span>
              ) : null}
              <ContextRing context={chat.context} />
              {busy ? (
                <>
                  {caps.supportsSteer ? (
                    <button type="button" className="pill-btn" disabled={empty || sending || !running || tooLong} onClick={() => void submit("steer")}>
                      Steer
                    </button>
                  ) : null}
                  {caps.supportsFollowUp ? (
                    <button type="button" className="pill-btn" disabled={empty || sending || !running || tooLong} onClick={() => void submit("followUp")}>
                      Follow-up
                    </button>
                  ) : null}
                  {!caps.supportsSteer ? (
                    <button type="button" className="pill-btn" disabled={empty || sending || stopping || tooLong} onClick={() => void submit("stopAndSend")}>
                      Stop and send
                    </button>
                  ) : null}
                  <button type="button" className="round-btn is-stop" onClick={onStop} disabled={stopping} aria-label="Stop the agent">
                    {stopping ? <Spinner size={14} /> : <IconStop size={14} />}
                  </button>
                </>
              ) : (
                <button type="button" className="round-btn" aria-label="Send" disabled={empty || sending || closed || tooLong} onClick={() => void submit("normal")}>
                  <IconArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
