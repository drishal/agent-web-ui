// The start screen: what the main pane shows while no chat is open — the
// question, the box, and the two choices that matter (agent and folder) right
// under it. Sending creates the chat and posts the message to it; nothing
// starts until the user presses Send. It reads like the hero of a just-made
// chat (hero.css, Composer's card), and the box and button carry the real
// composer's names ("Message", "Send") so every shortcut and test finds them.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { HarnessStatus } from "../../shared/protocol.js";
import { useDismiss } from "../hooks.js";
import { IconArrowUp, IconChevronDown, IconFolder, IconLink, IconX, Spinner } from "../icons.js";
import { dataUrl, type PendingImage } from "../images.js";
import { recentForChip, startAction, startHeading, startSendBlocked, startSetup, type StartSetup } from "../start-screen.js";
import { HarnessMenu } from "./HarnessMenu.js";

export function StartScreen({
  harnesses,
  harnessId,
  onHarness,
  workspace,
  recent,
  onPickFolder,
  onOpenRecent,
  onShowSessions,
  autoFocus,
  focusKey = 0,
  maxChars,
  busy,
  onSend,
  initialText = "",
  initialImages,
  initialLinkedHidden = null,
}: {
  harnesses: HarnessStatus[];
  harnessId: string | null;
  onHarness: (id: string) => void;
  workspace: { name: string; path: string } | null;
  /** Recent folder paths, newest first (the chip's menu, plus "Choose another folder…"). */
  recent: string[];
  onPickFolder: () => void;
  onOpenRecent: (path: string) => void;
  /** Phones only: the drawer of open sessions from the screen itself. */
  onShowSessions?: () => void;
  autoFocus: boolean;
  /** A change puts the focus back in the box (a folder was just picked). */
  focusKey?: number;
  maxChars: number;
  /** A send is in flight: the box is read-only and Send shows it. */
  busy: boolean;
  /** What a share or prompt link brought: the text (and its note) and images already in the box. */
  initialText?: string;
  initialImages?: PendingImage[];
  initialLinkedHidden?: number | null;
  /** The draft and the attached images (a share). Return true once the chat took them. */
  onSend: (text: string, images: PendingImage[]) => Promise<boolean>;
}) {
  const [text, setText] = useState(initialText);
  const [images, setImages] = useState<PendingImage[]>(initialImages ?? []);
  const [linkedHidden, setLinkedHidden] = useState<number | null>(initialLinkedHidden);
  const area = useRef<HTMLTextAreaElement>(null);
  const setup = (): StartSetup => startSetup(harnesses, harnessId, workspace?.name ?? null, text, images.length, busy);
  const heading = startHeading(setup());
  const blocked = startSendBlocked(setup());
  const name = harnesses.find((h) => h.id === harnessId)?.displayName ?? "the agent";
  const awui = harnessId === "awui";
  const tooLong = text.length > maxChars;

  // The box grows with the draft like the real composer's.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  // Focus once on desktop (a phone would open the keyboard at it).
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus, focusKey]);

  const submit = async () => {
    if (busy) return;
    const action = startAction(setup());
    if (action.kind === "pick-folder") {
      onPickFolder();
      return;
    }
    if (action.kind === "blocked") return;
    // Images go with the first message; the chat keeps them as its attachments.
    const ok = await onSend(text.trim(), images);
    if (ok) {
      setText("");
      setImages([]);
      setLinkedHidden(null);
    }
  };

  // Enter sends on a keyboard; on touch it adds a line (the Send button sends), as in the real composer.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || window.matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="hero start-screen">
      <div className="hero-inner">
        <h2 className="hero-title">
          {heading.project ? (
            <>
              {heading.before}
              <span className="hero-project">{heading.project}</span>
              {heading.after}
            </>
          ) : (
            heading.title
          )}
        </h2>
        <p className="hero-sub muted">
          {awui ? "It reads, searches, and computes — it never edits your files." : workspace ? "It runs with its normal tools, as you, in this folder." : "Choose the folder it should work in."}
        </p>
        <div className="composer is-hero">
          <div className="composer-card">
            {images.length > 0 ? (
              <ul className="composer-images" aria-label="Attached images">
                {images.map((image, i) => (
                  <li key={image.id} className="composer-image">
                    <img src={dataUrl(image)} alt={`Attached image #${i + 1}`} />
                    <button type="button" className="composer-image-remove" aria-label={`Remove image #${i + 1}`} onClick={() => setImages((list) => list.filter((_, j) => j !== i))}>
                      <IconX size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {linkedHidden !== null ? (
              <p className="composer-note composer-linked" role="status">
                <IconLink size={13} />
                <span>
                  From a link: read it before you send it.
                  {linkedHidden > 0 ? ` ${linkedHidden} hidden character${linkedHidden === 1 ? " was" : "s were"} taken out.` : ""}
                </span>
                <button type="button" className="icon-btn" aria-label="Dismiss the link note" onClick={() => setLinkedHidden(null)}>
                  <IconX size={11} />
                </button>
              </p>
            ) : null}
            <textarea
              ref={area}
              className="composer-input"
              rows={2}
              value={text}
              readOnly={busy}
              placeholder={`Ask ${name} to…`}
              aria-label="Message"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              enterKeyHint="send"
            />
            <div className="composer-bar">
              <div className="composer-controls">
                <HarnessMenu
                  variant="chip"
                  label="Agent for this chat"
                  menuLabel="Agent"
                  currentId={harnessId}
                  choices={harnesses.map((h) => ({ harness: h, blocked: h.available ? null : (h.reason ?? "Not available") }))}
                  onPick={onHarness}
                  ariaKeyShortcuts="Enter"
                />
                {!awui ? <FolderChip workspace={workspace} recent={recent} onPick={onPickFolder} onOpen={onOpenRecent} /> : null}
              </div>
              <div className="composer-actions">
                {tooLong ? (
                  <span className="composer-error">
                    {text.length.toLocaleString()} / {maxChars.toLocaleString()}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="round-btn"
                  aria-label="Send"
                  title={blocked ?? undefined}
                  disabled={blocked !== null || tooLong}
                  onClick={() => void submit()}
                >
                  {busy ? <Spinner size={16} /> : <IconArrowUp size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
        {onShowSessions ? (
          <button type="button" className="btn btn-ghost drawer-open-inline start-sessions" onClick={onShowSessions}>
            Show sessions
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The folder chip: its menu lists the recent folders, then "Choose another
 * folder…" for the browser. With no folder chosen it stands out (accent
 * outline) so the one missing choice is obvious.
 */
function FolderChip({ workspace, recent, onPick, onOpen }: { workspace: { name: string; path: string } | null; recent: string[]; onPick: () => void; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  useDismiss(wrap, open, () => setOpen(false));
  const items = recentForChip(recent, workspace?.path ?? null);
  const pick = (run: () => void) => {
    setOpen(false);
    run();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons?.length) return;
    const index = [...buttons].findIndex((b) => b === document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (buttons[(index + 1) % buttons.length] as HTMLButtonElement).focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (buttons[(index - 1 + buttons.length) % buttons.length] as HTMLButtonElement).focus();
    }
  };
  useEffect(() => {
    if (open) menu.current?.querySelector("button")?.focus();
  }, [open]);
  const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
  return (
    <div className="folder-chip-wrap" ref={wrap}>
      <button
        type="button"
        className={`folder-chip${workspace ? "" : " is-needed"}`}
        aria-label={`Folder: ${workspace?.name ?? "none chosen"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={workspace?.path}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconFolder size={13} />
        <span className="folder-chip-name">{workspace?.name ?? "Choose a folder"}</span>
        <IconChevronDown size={12} />
      </button>
      {open ? (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <ul ref={menu} className="menu-list folder-menu" role="menu" aria-label="Folder" onKeyDown={onKey}>
            {items.map((path, i) => (
              <li key={path} role="none">
                <button type="button" role="menuitem" title={path} onClick={() => pick(() => onOpen(path))}>
                  <IconFolder size={13} />
                  <span className="folder-menu-name">{folderName(path)}</span>
                  <span className="folder-menu-path muted">{path}</span>
                </button>
              </li>
            ))}
            <li role="none" className="folder-menu-other">
              <button type="button" role="menuitem" onClick={() => pick(onPick)}>
                Choose another folder…
              </button>
            </li>
          </ul>
        </>
      ) : null}
    </div>
  );
}
