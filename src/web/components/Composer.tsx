// The composer card (DeepSeek Harness): text on top, settings and actions in
// the bottom row, a status stack above, approvals taking over the card.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IMAGE_MIME_TYPES, type HarnessStatus, type ImageAttachment, type InteractionAnswer, MAX_IMAGES, type SendMode, type SlashCommand } from "../../shared/protocol.js";
import { api } from "../api.js";
import type { ChatState } from "../chat-state.js";
import { APP_COMMANDS, matchCommands, mergeCommands } from "../commands.js";
import { IconArrowUp, IconImage, IconStop, IconTerminal, IconX, Spinner } from "../icons.js";
import { dataUrl, imageFiles, type PendingImage, prepareImage } from "../images.js";
import { ImageViewer, imageSize } from "./ImageViewer.js";
import { load, save } from "../storage.js";
import { ApprovalStack } from "./ApprovalStack.js";
import { ComposerControls } from "./ComposerControls.js";
import { ContextRing } from "./ContextRing.js";
import { StatusStack } from "./StatusStack.js";
import { useAddToDraft } from "../draft-bus.js";
import { GitPanel, GitRow } from "./GitStatusView.js";
import { useGitStatus } from "../git.js";

/** Context share (%) from which the chip is offered, and from which it starts on. */
const COMPACT_OFFER = 50;
const COMPACT_DEFAULT = 80;

const formatTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const coarsePointer = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export function Composer({
  chat,
  harnesses,
  maxChars,
  hero,
  placeholder,
  onSend,
  onStop,
  onAnswer,
  onConfig,
  onRefreshModels,
  onHandoff,
  onNewChat,
}: {
  chat: ChatState;
  harnesses: HarnessStatus[];
  maxChars: number;
  hero?: boolean;
  placeholder?: string;
  onSend: (text: string, mode: SendMode, images: ImageAttachment[], options?: { compactFirst?: boolean }) => Promise<boolean>;
  onStop: () => void;
  onAnswer: (requestId: string, answer: InteractionAnswer) => Promise<void>;
  onConfig: (patch: { model?: string; thinkingLevel?: string }) => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onHandoff: (harnessId: string, draft: string) => Promise<void>;
  /** Ctrl+Alt+Enter: once the message is sent, open a new chat. */
  onNewChat?: () => void;
}) {
  const draftKey = `draft.${chat.chatId}`;
  const [text, setText] = useState(() => load<string>(draftKey, ""));
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const { git, at: gitAt, refresh: refreshGit } = useGitStatus(chat.chatId, chat.status);
  const [gitOpen, setGitOpen] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const thumbs = useRef(new Map<number, HTMLElement>());
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

  const tooLong = text.length > maxChars;

  useAddToDraft((added) => {
    setText((current) => (current.trim() ? `${current.replace(/\s*$/, "")}\n\n${added}` : added));
    window.requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  });

  // Compact before send (T3 Code's chip): offered once the context is half full, on by
  // default from COMPACT_DEFAULT; the choice lasts until a message goes.
  const percent = chat.context?.percent ?? null;
  const offerCompact = caps.supportsCompact && chat.context?.tokens != null && percent !== null && percent >= COMPACT_OFFER;
  const [compactChoice, setCompactChoice] = useState<boolean | null>(null);
  const compactFirst = offerCompact && (compactChoice ?? (percent ?? 0) >= COMPACT_DEFAULT);

  const submit = useCallback(
    async (mode: SendMode) => {
      const value = text.trim();
      if (!value || sending || tooLong) return false;
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
        mode === "normal" && compactFirst ? { compactFirst: true } : {},
      );
      setSending(false);
      if (ok) setCompactChoice(null);
      if (!ok) {
        setText((current) => current || value);
        setImages((current) => (current.length > 0 ? current : attached));
      }
      area.current?.focus();
      return ok;
    },
    [onSend, sending, text, images, compactFirst],
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

  // The "/" menu (Hermes Desktop's): open while the first word is still being typed.
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuId = useId();
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const menuOpen = slashQuery !== undefined && !menuDismissed && !closed;
  const menuItems = menuOpen ? matchCommands(commands ?? APP_COMMANDS, slashQuery) : [];
  const activeCommand = menuItems[Math.min(menuIndex, menuItems.length - 1)];

  useEffect(() => {
    if (!menuOpen || commands !== null) return;
    let cancelled = false;
    api<{ commands: SlashCommand[] }>(`/api/chats/${chat.chatId}/commands`).then(
      (r) => !cancelled && setCommands(mergeCommands(r.commands)),
      () => !cancelled && setCommands(mergeCommands([])),
    );
    return () => {
      cancelled = true;
    };
  }, [menuOpen, commands, chat.chatId]);

  useEffect(() => {
    setMenuIndex(0);
    if (slashQuery === undefined) setMenuDismissed(false);
  }, [slashQuery]);

  useEffect(() => {
    if (menuOpen) document.getElementById(`${menuId}-${menuIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, menuIndex, menuId]);

  const completeCommand = (c: SlashCommand) => {
    setText(`/${c.name} `);
    area.current?.focus();
  };

  /** Arrow keys move, Tab/Enter complete, Esc closes; true when the key was the menu's. */
  const menuKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!menuOpen) return false;
    if (e.key === "Escape") {
      setMenuDismissed(true);
      return true;
    }
    if (menuItems.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setMenuIndex((i) => (i + step + menuItems.length) % menuItems.length);
      return true;
    }
    if (e.key !== "Tab" && (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)) return false;
    // A command typed in full that takes nothing more runs on Enter; otherwise the key completes it.
    if (e.key === "Enter" && activeCommand?.name === slashQuery && !activeCommand.hint) return false;
    if (activeCommand) completeCommand(activeCommand);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || coarsePointer()) return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      if (!busy) void submit("normal").then((ok) => ok && onNewChat?.());
      return;
    }
    if (!busy) void submit("normal");
    else if (caps.supportsSteer && running) void submit("steer");
  };

  const empty = !text.trim();
  const model = chat.config.models.find((m) => m.key === chat.config.model);
  const blind = images.length > 0 && model?.vision === false;
  const pending = closed ? [] : chat.pending;

  return (
    <div className={`composer${hero ? " is-hero" : ""}`}>
      <StatusStack
        chatId={chat.chatId}
        queue={chat.queue}
        todos={chat.todos}
        extensionStatus={chat.extensionStatus}
        base={git ? <GitRow git={git} onOpen={() => setGitOpen(true)} /> : null}
      />
      {gitOpen && git ? <GitPanel chatId={chat.chatId} git={git} at={gitAt} onRefresh={refreshGit} onClose={() => setGitOpen(false)} /> : null}
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
              {images.map((image, i) => {
                const size = imageSize(image);
                return (
                  <li key={image.id} className="composer-image">
                    <button
                      type="button"
                      className="composer-image-open"
                      aria-label={`View image #${i + 1}`}
                      title={`Image #${i + 1}${size ? ` · ${size}` : ""}`}
                      ref={(el) => {
                        if (el) thumbs.current.set(i, el);
                        else thumbs.current.delete(i);
                      }}
                      onClick={() => setViewing(i)}
                    >
                      <img src={dataUrl(image)} alt={`Attached image #${i + 1}`} />
                    </button>
                    <span className="image-label" aria-hidden="true">
                      <strong>#{i + 1}</strong>
                      {size ? <span>{size}</span> : null}
                    </span>
                    <button
                      type="button"
                      className="composer-image-remove"
                      aria-label={`Remove image #${i + 1}`}
                      onClick={() => setImages((current) => current.filter((x) => x.id !== image.id))}
                    >
                      <IconX size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {imageError || blind ? (
            <p className="composer-note" role="status">
              {imageError ?? `${model?.name ?? "This model"} does not take image input; switch to a vision model before sending.`}
            </p>
          ) : null}
          {menuOpen ? (
            <div className="command-menu" id={menuId} role="listbox" aria-label="Commands">
              <div className="command-menu-head" aria-hidden="true">
                Commands
              </div>
              {menuItems.length === 0 ? (
                <div className="command-empty">{commands === null ? "Loading commands…" : `No command matches /${slashQuery}`}</div>
              ) : (
                menuItems.map((c, i) => (
                  <div
                    key={`${c.source}:${c.name}`}
                    id={`${menuId}-${i}`}
                    role="option"
                    aria-selected={i === menuIndex}
                    className={`command-item${i === menuIndex ? " is-active" : ""}`}
                    title={c.description ? `/${c.name}${c.hint ? ` ${c.hint}` : ""}: ${c.description}` : undefined}
                    onPointerMove={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      // Keep the caret in the composer.
                      e.preventDefault();
                      completeCommand(c);
                    }}
                  >
                    <IconTerminal size={14} />
                    <span className="command-name">/{c.name}</span>
                    {c.description ? <span className="command-desc">{c.description}</span> : null}
                    {c.source === "skill" || c.source === "prompt" || c.source === "app" ? <span className="command-source">{c.source}</span> : null}
                  </div>
                ))
              )}
            </div>
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
            aria-autocomplete="list"
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen && menuItems.length > 0 ? `${menuId}-${menuIndex}` : undefined}
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
            <ComposerControls chat={chat} harnesses={harnesses} onConfig={onConfig} onRefreshModels={onRefreshModels} onHandoff={(id) => onHandoff(id, text)} />
            <div className="composer-actions">
              {tooLong ? (
                <span className="composer-error">
                  {text.length.toLocaleString()} / {maxChars.toLocaleString()}
                </span>
              ) : null}
              {offerCompact && !busy ? (
                <button
                  type="button"
                  className={`compact-chip${compactFirst ? " is-on" : ""}`}
                  aria-pressed={compactFirst}
                  title={
                    compactFirst
                      ? "On: Enter compacts the context first, then sends. Click to send with the full history."
                      : "Off: the next message goes with the full history. Click to compact first."
                  }
                  onClick={() => setCompactChoice(!compactFirst)}
                  data-testid="compact-chip"
                >
                  {compactFirst ? "Compact" : "Full"} {formatTokens(chat.context?.tokens ?? 0)}
                </button>
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
      {viewing !== null && images[viewing] ? (
        <ImageViewer images={images.map((i) => ({ src: dataUrl(i), width: i.width, height: i.height }))} start={viewing} thumbnail={(i) => thumbs.current.get(i) ?? null} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}
