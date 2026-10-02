// The composer card (DeepSeek Harness): text on top, settings and actions in
// the bottom row, a status stack above, approvals taking over the card.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IMAGE_MIME_TYPES, type ImageAttachment, type InteractionAnswer, MAX_IMAGES, type SendMode } from "../../shared/protocol.js";
import type { ChatState } from "../chat-state.js";
import { IconArrowUp, IconImage, IconStop, IconX, Spinner } from "../icons.js";
import { dataUrl, imageFiles, type PendingImage, prepareImage } from "../images.js";
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
  onRefreshModels,
}: {
  chat: ChatState;
  maxChars: number;
  hero?: boolean;
  placeholder?: string;
  onSend: (text: string, mode: SendMode, images: ImageAttachment[]) => Promise<boolean>;
  onStop: () => void;
  onAnswer: (requestId: string, answer: InteractionAnswer) => Promise<void>;
  onConfig: (patch: { model?: string; thinkingLevel?: string }) => Promise<void>;
  onRefreshModels: () => Promise<void>;
}) {
  const draftKey = `draft.${chat.chatId}`;
  const [text, setText] = useState(() => load<string>(draftKey, ""));
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
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
      // restore only if the send failed and nothing new was typed or attached.
      const attached = images;
      setSending(true);
      setText("");
      setImages([]);
      setImageError(null);
      const ok = await onSend(
        value,
        mode,
        attached.map(({ mimeType, data }) => ({ mimeType, data })),
      );
      setSending(false);
      if (!ok) {
        setText((current) => current || value);
        setImages((current) => (current.length > 0 ? current : attached));
      }
      area.current?.focus();
    },
    [onSend, sending, text, images],
  );

  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    setImageError(null);
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setImageError(`Up to ${MAX_IMAGES} images per message`);
      return;
    }
    const added: PendingImage[] = [];
    for (const file of files.slice(0, room)) {
      try {
        added.push(await prepareImage(file));
      } catch (error) {
        setImageError(error instanceof Error ? error.message : String(error));
      }
    }
    if (files.length > room) setImageError(`Up to ${MAX_IMAGES} images per message`);
    setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
    area.current?.focus();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData.files);
    // Spreadsheets and rich editors copy a rendering beside the text; paste the text then.
    if (files.length === 0 || e.clipboardData.getData("text/plain")) return;
    e.preventDefault();
    void addImages(files);
  };

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || coarsePointer()) return;
    e.preventDefault();
    if (!busy) void submit("normal");
    else if (caps.supportsSteer && running) void submit("steer");
  };

  const tooLong = text.length > maxChars;
  const empty = !text.trim();
  const model = chat.config.models.find((m) => m.key === chat.config.model);
  const blind = images.length > 0 && model?.vision === false;
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
        <div
          className={`composer-card${closed ? " is-closed" : ""}${dragging ? " is-dragging" : ""}`}
          onDragOver={(e) => {
            if (closed || !hasFiles(e)) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (closed || !hasFiles(e)) return;
            e.preventDefault();
            setDragging(false);
            void addImages(imageFiles(e.dataTransfer.files));
          }}
        >
          {images.length > 0 ? (
            <ul className="composer-images" aria-label="Attached images">
              {images.map((image, i) => (
                <li key={image.id} className="composer-image">
                  <img src={dataUrl(image)} alt={`Attached image ${i + 1}`} />
                  <button
                    type="button"
                    className="composer-image-remove"
                    aria-label={`Remove image ${i + 1}`}
                    onClick={() => setImages((current) => current.filter((x) => x.id !== image.id))}
                  >
                    <IconX size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {imageError || blind ? (
            <p className="composer-note" role="status">
              {imageError ?? `${model?.name ?? "This model"} does not take image input; switch to a vision model before sending.`}
            </p>
          ) : null}
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
                  : images.length > 0
                    ? "Say what to do with the image…"
                    : (placeholder ?? "Message the agent…")
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-label="Message"
            enterKeyHint={coarsePointer() ? "enter" : "send"}
          />
          <div className="composer-bar">
            <button
              type="button"
              className="icon-btn composer-attach"
              aria-label="Attach images"
              title="Attach images (or paste / drop them)"
              disabled={closed || images.length >= MAX_IMAGES}
              onClick={() => filePicker.current?.click()}
            >
              <IconImage size={16} />
            </button>
            <input
              ref={filePicker}
              type="file"
              accept={IMAGE_MIME_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                void addImages(imageFiles(e.target.files));
                e.target.value = "";
              }}
            />
            <ComposerControls chat={chat} onConfig={onConfig} onRefreshModels={onRefreshModels} />
            <div className="composer-actions">
              {tooLong ? (
                <span className="composer-error">
                  {text.length.toLocaleString()} / {maxChars.toLocaleString()}
                </span>
              ) : null}
              <ContextRing context={chat.context} usage={chat.usage} />
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
