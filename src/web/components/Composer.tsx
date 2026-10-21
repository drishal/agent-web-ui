// The composer card (DeepSeek Harness): text on top, settings and actions in
// the bottom row, a status stack above, approvals taking over the card. From
// T3 Code: ↑/↓ recall this chat's prompts, Shift+Enter continues a Markdown
// list (Tab indents it), the stash parks a draft for later (Alt+S), a prompt
// link's text arrives with a note to read it, and a run stopped on a usage
// limit offers to continue when the limit resets.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ChainStep, type ConfigPatch, IMAGE_MIME_TYPES, type HarnessStatus, type ImageAttachment, type InteractionAnswer, MAX_IMAGES, MAX_PASTE_BYTES, type PasteAttachment, type QueueState, type SendMode, type SlashCommand, type UsageLimits } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import type { ChatState } from "../chat-state.js";
import { APP_COMMANDS, isSkill, mergeCommands, skillMenu, skillName, slashMenu } from "../commands.js";
import { blanks, matchPrompts, nextBlank, promptGist } from "../prompt-blanks.js";
import { managePrompts, useSavedPrompts } from "../saved-prompts.js";
import { IconArrowUp, IconChevronDown, IconImage, IconLink, IconPlan, IconSpark, IconStash, IconStop, IconTerminal, IconX, Spinner } from "../icons.js";
import { dataUrl, imageFiles, type PendingImage, pendingImage, prepareImage } from "../images.js";
import { ImageViewer, imageSize } from "./ImageViewer.js";
import { load, save } from "../storage.js";
import { ApprovalStack } from "./ApprovalStack.js";
import { ComposerControls } from "./ComposerControls.js";
import { ContextRing } from "./ContextRing.js";
import { StatusStack } from "./StatusStack.js";
import { useAddImagesToDraft, useAddToDraft, useLinkedPrompt } from "../draft-bus.js";
import { recallStep, sentPrompts, type Recall } from "../prompt-history.js";
import { continueList, indentList } from "../list-continue.js";
import { loadStash, saveStash, stashDraft, takeFromStash, type StashEntry } from "../stash.js";
import { CONTINUE_TEXT, limitStop } from "../limit-stop.js";
import { LimitRecovery } from "./LimitRecovery.js";
import { useDismiss, useNow } from "../hooks.js";
import { formatDuration } from "../turns.js";
import { GitPanel, GitRow } from "./GitStatusView.js";
import { useGitStatus } from "../git.js";
import { Dot, dotted } from "./Dot.js";
import { Rolling } from "./Rolling.js";

/** Paste larger than this many UTF-16 chars offers "attach as file" instead of filling the box. */
const PASTE_FILE_OFFER = 12_000;

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
  limits,
  side = false,
}: {
  chat: ChatState;
  harnesses: HarnessStatus[];
  maxChars: number;
  hero?: boolean;
  placeholder?: string;
  onSend: (text: string, mode: SendMode, images: ImageAttachment[], options?: { compactFirst?: boolean; attachments?: string[] }) => Promise<boolean>;
  onStop: () => void;
  onAnswer: (requestId: string, answer: InteractionAnswer) => Promise<void>;
  onConfig: (patch: ConfigPatch) => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onHandoff: (harnessId: string, draft: string) => Promise<void>;
  /** Ctrl+Alt+Enter: once the message is sent, open a new chat. */
  onNewChat?: () => void;
  /** The subscriptions' limits: where a stop on a usage limit learns when it resets. */
  limits?: UsageLimits | null;
  /** The chat beside the main one: text sent to "the draft" from elsewhere (a quote, a mention) goes to the main composer, not here too. */
  side?: boolean;
}) {
  const draftKey = `draft.${chat.chatId}`;
  const [text, setText] = useState(() => load<string>(draftKey, ""));
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const { git, at: gitAt, refresh: refreshGit } = useGitStatus(chat.chatId, chat.status);
  const [gitOpen, setGitOpen] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  // A big pasted blob the user chose to send as a file instead of inline text.
  const [pastes, setPastes] = useState<PasteAttachment[]>([]);
  // The oversized paste awaiting the user's choice (inline vs file).
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const thumbs = useRef(new Map<number, HTMLElement>());
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const caps = chat.capabilities;
  const running = chat.status === "running";
  const stopping = chat.status === "stopping";
  const busy = running || stopping || chat.status === "compacting";
  // The phone's thumb bar: how long this run has gone, from its prompt.
  const now = useNow(running);
  const runStart = running ? [...chat.items].reverse().find((i) => i.kind === "user")?.at : undefined;
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

  // ↑/↓ walk this chat's sent prompts (prompt-history.ts); an edit ends the walk.
  const recall = useRef<Recall | null>(null);
  // Where the caret goes once a text set by a key (recall, a list, the stash) has rendered.
  const caretAfter = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const at = caretAfter.current;
    const el = area.current;
    if (!at || !el) return;
    caretAfter.current = null;
    el.setSelectionRange(at[0], at[1]);
  }, [text]);
  const setTextAt = (next: string, from: number, to = from) => {
    caretAfter.current = [from, to];
    setText(next);
  };

  // A prompt link's text: into an empty composer (else after the draft), with a note to read it first.
  const [linked, setLinked] = useState<{ hidden: number } | null>(null);
  useLinkedPrompt((prompt) => {
    setText((current) => (current.trim() ? `${current.replace(/\s*$/, "")}\n\n${prompt.text}` : prompt.text));
    setLinked({ hidden: prompt.hidden });
    window.requestAnimationFrame(() => area.current?.focus());
  }, !side);

  useAddToDraft((added) => {
    setText((current) => (current.trim() ? `${current.replace(/\s*$/, "")}\n\n${added}` : added));
    window.requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, !side);

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
      const pasted = pastes;
      setSending(true);
      setText("");
      setImages([]);
      setPastes([]);
      setImageError(null);
      setLinked(null);
      recall.current = null;
      const ok = await onSend(
        value,
        mode,
        attached.map(({ mimeType, data }) => ({ mimeType, data })),
        { ...(mode === "normal" && compactFirst ? { compactFirst: true } : {}), ...(pasted.length > 0 ? { attachments: pasted.map((p) => p.id) } : {}) },
      );
      setSending(false);
      if (ok) setCompactChoice(null);
      if (!ok) {
        setText((current) => current || value);
        setImages((current) => (current.length > 0 ? current : attached));
        setPastes((current) => (current.length > 0 ? current : pasted));
      }
      area.current?.focus();
      return ok;
    },
    [onSend, sending, text, images, pastes, compactFirst],
  );

  /** Park the oversized paste as a file on the server and chip it. */
  const attachPaste = async () => {
    if (!pendingPaste || pasteBusy) return;
    setPasteBusy(true);
    setImageError(null);
    try {
      const blob = pendingPaste;
      if (new TextEncoder().encode(blob).length > MAX_PASTE_BYTES) {
        setImageError("That paste is larger than the 1 MiB file limit");
        return;
      }
      const pasted = await api<PasteAttachment>(`/api/chats/${chat.chatId}/pastes`, { body: { text: blob } });
      setPastes((current) => [...current, pasted].slice(0, 4));
      setPendingPaste(null);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setPasteBusy(false);
      area.current?.focus();
    }
  };

  /** The user wants it inline after all. */
  const inlinePaste = () => {
    if (pendingPaste === null) return;
    setText((current) => current + pendingPaste);
    setPendingPaste(null);
    area.current?.focus();
  };

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
  // Images from elsewhere: what another app shared to awui.
  useAddImagesToDraft((files) => void addImages(files), !side);

  // The stash (stash.ts): park this draft, or take one back (what is here then goes in its place).
  const [stash, setStash] = useState<StashEntry[]>(loadStash);
  const [stashOpen, setStashOpen] = useState(false);
  const stashRef = useRef<HTMLDivElement>(null);
  // Escape closes it wherever the focus is; the focus starts on its first item that can be used.
  useDismiss(stashRef, stashOpen, () => setStashOpen(false), { escape: true, outside: false });
  useEffect(() => {
    if (stashOpen) stashRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [stashOpen]);
  const [stashNote, setStashNote] = useState<string | null>(null);
  useEffect(() => {
    if (!stashNote) return;
    const t = window.setTimeout(() => setStashNote(null), 2500);
    return () => window.clearTimeout(t);
  }, [stashNote]);
  const from = chat.title || "New chat";
  const stashNow = () => {
    const next = stashDraft(loadStash(), { text, images, from });
    if (!next) return;
    if (!saveStash(next)) {
      setImageError("The browser's storage is full: the draft stays here");
      return;
    }
    const dropped = next[0]?.dropped ?? 0;
    setStash(next);
    setStashOpen(false);
    setText("");
    setImages([]);
    setLinked(null);
    setStashNote(dropped > 0 ? `Stashed; ${dropped} image${dropped === 1 ? " was" : "s were"} too big to keep` : "Stashed");
  };
  const unstash = (id: string) => {
    const { entries, entry } = takeFromStash(loadStash(), id);
    if (!entry) return;
    const swapped = stashDraft(entries, { text, images, from }) ?? entries;
    saveStash(swapped);
    setStash(swapped);
    setStashOpen(false);
    setTextAt(entry.text, entry.text.length);
    setImages(entry.images.map(pendingImage).slice(0, MAX_IMAGES));
    area.current?.focus();
  };
  const dropStashed = (id: string) => {
    const { entries } = takeFromStash(loadStash(), id);
    saveStash(entries);
    setStash(entries);
  };

  // An edited or removed queued message (StatusStack): the whole queue goes back to the harness.
  // The chain (the server's): steps that run once this run is over, even with the page closed.
  const name = (id: string) => harnesses.find((h) => h.id === id)?.displayName ?? id;
  const setChain = async (steps: ChainStep[], resume = false): Promise<boolean> => {
    try {
      const plain = steps.map((s) => (s.kind === "send" ? { kind: s.kind, text: s.text } : { kind: s.kind, harness: s.harness, ...(s.prompt ? { prompt: s.prompt } : {}) }));
      await api(`/api/chats/${chat.chatId}/chain`, { method: "PUT", body: { steps: plain, ...(resume ? { resume: true } : {}) } });
      return true;
    } catch (error) {
      setImageError(errorText(error));
      return false;
    }
  };
  const [thenMenu, setThenMenu] = useState(false);
  /** The draft as the chain's next step: sent when the run before it is over (or, with `harness`, a handoff carrying it). */
  const addThen = async (harness?: string) => {
    const draft = text.trim();
    if (!harness && !draft) return;
    const step = harness ? { id: "", kind: "handoff" as const, harness, ...(draft ? { prompt: draft } : {}) } : { id: "", kind: "send" as const, text: draft };
    if (await setChain([...chat.chain, step])) {
      // Only what went into the step: anything typed while it was on its way stays.
      setText((current) => (current.trim() === draft ? "" : current));
      setThenMenu(false);
    }
  };

  const editQueue = caps.supportsQueueEdit
    ? async (queue: QueueState): Promise<boolean> => {
        try {
          await api(`/api/chats/${chat.chatId}/queue`, { method: "PUT", body: queue });
          return true;
        } catch (error) {
          setImageError(errorText(error));
          return false;
        }
      }
    : undefined;

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData.files);
    // Spreadsheets and rich editors copy a rendering beside the text; paste the text then.
    if (files.length === 0 || e.clipboardData.getData("text/plain")) {
      // A big text blob would flood the box and the context; offer sending it as a file.
      const blob = e.clipboardData.getData("text/plain");
      if (blob.length > PASTE_FILE_OFFER) {
        e.preventDefault();
        setPendingPaste(blob);
      }
      return;
    }
    e.preventDefault();
    void addImages(files);
  };

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  // The "/" menu (Hermes Desktop's): open while the first word is still being typed.
  // "$" is the skills' own menu, where the harness has any (elsewhere a "$" is just typed).
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuId = useId();
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const skillQuery = /^\$(\S*)$/.exec(text)?.[1];
  // "#" lists the saved prompts (the server's, for every device), where there are any.
  const savedPrompts = useSavedPrompts();
  const promptQuery = /^#(\S*)$/.exec(text)?.[1];
  const skillCount = commands ? commands.filter(isSkill).length : 0;
  const menuKind =
    closed || menuDismissed
      ? null
      : slashQuery !== undefined
        ? "slash"
        : skillQuery !== undefined && skillCount > 0
          ? "skill"
          : promptQuery !== undefined && (savedPrompts?.length ?? 0) > 0
            ? "prompt"
            : null;
  const menuOpen = menuKind !== null;
  const promptMatches = menuKind === "prompt" ? matchPrompts(savedPrompts ?? [], promptQuery ?? "") : [];
  const menuItems =
    menuKind === "slash"
      ? slashMenu(commands ?? APP_COMMANDS, slashQuery ?? "")
      : menuKind === "skill"
        ? skillMenu(commands ?? [], skillQuery ?? "")
        : promptMatches.map((p): SlashCommand => ({ name: p.name, description: promptGist(p), source: "saved" }));
  const activeCommand = menuItems[Math.min(menuIndex, menuItems.length - 1)];
  const wantsCommands = (slashQuery !== undefined || skillQuery !== undefined) && !closed;

  useEffect(() => {
    if (!wantsCommands || commands !== null) return;
    let cancelled = false;
    api<{ commands: SlashCommand[] }>(`/api/chats/${chat.chatId}/commands`).then(
      (r) => !cancelled && setCommands(mergeCommands(r.commands)),
      () => !cancelled && setCommands(mergeCommands([])),
    );
    return () => {
      cancelled = true;
    };
  }, [wantsCommands, commands, chat.chatId]);

  useEffect(() => {
    setMenuIndex(0);
    if (slashQuery === undefined && skillQuery === undefined && promptQuery === undefined) setMenuDismissed(false);
  }, [slashQuery, skillQuery, promptQuery]);

  useEffect(() => {
    if (menuOpen) document.getElementById(`${menuId}-${menuIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, menuIndex, menuId]);

  const completeCommand = (c: SlashCommand) => {
    if (menuKind === "prompt") {
      const p = promptMatches.find((x) => x.name === c.name);
      if (p) insertPrompt(p.text);
      return;
    }
    setText(`/${c.name} `);
    area.current?.focus();
  };
  /** A saved prompt replaces the draft, its first blank selected to type over. */
  const insertPrompt = (value: string) => {
    const first = blanks(value)[0];
    setTextAt(value, first?.start ?? value.length, first?.end ?? value.length);
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
    if (e.key === "Enter" && activeCommand && activeCommand.name === slashQuery && !activeCommand.hint) return false;
    if (activeCommand) completeCommand(activeCommand);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuKey(e)) {
      e.preventDefault();
      return;
    }
    const el = e.currentTarget;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyS") {
      e.preventDefault();
      stashNow();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && plain && !e.shiftKey) {
      const step = recallStep(sentPrompts(chat.items), recall.current, e.key === "ArrowUp" ? "up" : "down", text, el.selectionStart);
      if (step) {
        e.preventDefault();
        recall.current = step.recall;
        setTextAt(step.text, step.text.length);
      }
      return;
    }
    if (e.key === "Tab" && plain) {
      // A saved prompt's blanks: Tab to the next, Shift+Tab back (unless the only one is already selected).
      const blank = nextBlank(text, e.shiftKey ? el.selectionStart : el.selectionEnd, e.shiftKey);
      if (blank && !(blank.start === el.selectionStart && blank.end === el.selectionEnd)) {
        e.preventDefault();
        el.setSelectionRange(blank.start, blank.end);
        return;
      }
      const next = indentList(text, el.selectionStart, el.selectionEnd, e.shiftKey);
      if (next) {
        e.preventDefault();
        setTextAt(next.text, next.from, next.to);
      }
      return;
    }
    // While a run goes: the draft as the chain's next step, sent once the run is over.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && busy) {
      e.preventDefault();
      void addThen();
      return;
    }
    // A new line (Shift+Enter, or Enter on a touch screen) inside a list item starts the next item.
    if (e.key === "Enter" && plain && (e.shiftKey || coarsePointer()) && el.selectionStart === el.selectionEnd) {
      const next = continueList(text, el.selectionStart);
      if (next) {
        e.preventDefault();
        setTextAt(next.text, next.caret);
      }
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
  const harnessName = harnesses.find((h) => h.id === chat.harnessId)?.displayName ?? chat.harnessId;
  const stopped = useMemo(() => limitStop(chat.items, chat.status, limits ?? null, harnessName), [chat.items, chat.status, limits, harnessName]);

  return (
    <div className={`composer${hero ? " is-hero" : ""}`}>
      {busy ? (
        <div className="thumb-bar" role="status">
          <Spinner size={13} />
          <span className="thumb-bar-label">
            {stopping ? "Stopping" : chat.status === "compacting" ? "Compacting" : "Working"}
            {runStart ? (
              <>
                <Dot />
                <Rolling text={formatDuration(Math.max(0, now - runStart))} />
              </>
            ) : null}
          </span>
          {running ? (
            <button type="button" className="btn btn-small thumb-stop" onClick={onStop} aria-label="Stop now">
              <IconStop size={13} /> Stop
            </button>
          ) : null}
        </div>
      ) : null}
      <StatusStack
        chatId={chat.chatId}
        queue={chat.queue}
        todos={chat.todos}
        notice={chat.extensionStatus[`${chat.harnessId}:status`] ?? null}
        onEditQueue={editQueue}
        chain={chat.chain}
        chainPaused={chat.chainPaused}
        harnessName={name}
        onChain={setChain}
        base={git ? <GitRow git={git} onOpen={() => setGitOpen(true)} /> : null}
      />
      {gitOpen && git ? <GitPanel chatId={chat.chatId} git={git} at={gitAt} onRefresh={refreshGit} onClose={() => setGitOpen(false)} /> : null}
      {stopped && !busy && pending.length === 0 && !closed ? (
        <LimitRecovery key={stopped.id} chatId={chat.chatId} stop={stopped} idle={!busy} onContinue={() => void onSend(CONTINUE_TEXT, "normal", [])} />
      ) : null}
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
          {pendingPaste !== null ? (
            <div className="paste-offer" role="group" aria-label="Large paste">
              <span className="paste-offer-note">Pasting {(pendingPaste.length / 1024).toFixed(0)} KB ({pendingPaste.split("\n").length.toLocaleString("en-US")} lines)</span>
              <button type="button" className="btn btn-small" disabled={pasteBusy} onClick={() => void attachPaste()}>
                {pasteBusy ? "Saving…" : "Attach as file"}
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={pasteBusy} onClick={inlinePaste}>
                Paste inline
              </button>
            </div>
          ) : null}
          {pastes.length > 0 ? (
            <ul className="composer-pastes" aria-label="Pasted files">
              {pastes.map((paste, i) => (
                <li key={paste.id} className="composer-paste">
                  <span className="paste-label" title={paste.path}>
                    <strong>paste-{i + 1}.txt</strong> {paste.lines.toLocaleString("en-US")} lines
                    <Dot />
                    {(paste.bytes / 1024).toFixed(1)} KB
                  </span>
                  <button
                    type="button"
                    className="composer-image-remove"
                    aria-label={`Remove paste #${i + 1}`}
                    onClick={() => setPastes((current) => current.filter((x) => x.id !== paste.id))}
                  >
                    <IconX size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
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
          {linked ? (
            <p className="composer-note composer-linked" role="status">
              <IconLink size={13} />
              <span>
                From a link: read it before you send it.
                {linked.hidden > 0 ? ` ${linked.hidden} hidden character${linked.hidden === 1 ? " was" : "s were"} taken out.` : ""}
              </span>
              <button type="button" className="icon-btn" aria-label="Dismiss the link note" onClick={() => setLinked(null)}>
                <IconX size={11} />
              </button>
            </p>
          ) : null}
          {stashNote ? (
            <p className="composer-note" role="status">
              {stashNote}
            </p>
          ) : null}
          {menuOpen ? (
            <div
              className={`command-menu${menuKind === "skill" ? " is-skills" : menuKind === "prompt" ? " is-prompts" : ""}`}
              id={menuId}
              role="listbox"
              aria-label={menuKind === "skill" ? "Skills" : menuKind === "prompt" ? "Saved prompts" : "Commands"}
            >
              <div className="command-menu-head" aria-hidden="true">
                {menuKind === "skill" ? dotted(["Skills", skillCount]) : menuKind === "prompt" ? dotted(["Saved prompts", savedPrompts?.length ?? 0]) : "Commands"}
              </div>
              {menuItems.length === 0 ? (
                <div className="command-empty">
                  {menuKind === "prompt"
                    ? `No saved prompt matches #${promptQuery}`
                    : commands === null
                      ? "Loading commands…"
                      : menuKind === "skill"
                        ? `No skill matches $${skillQuery}`
                        : `No command matches /${slashQuery}`}
                </div>
              ) : (
                menuItems.map((c, i) => (
                  <div
                    key={`${c.source}:${c.name}`}
                    id={`${menuId}-${i}`}
                    role="option"
                    aria-selected={i === menuIndex}
                    className={`command-item${i === menuIndex ? " is-active" : ""}`}
                    title={c.description ? `${menuKind === "skill" ? `$${skillName(c)}` : `/${c.name}`}${c.hint ? ` ${c.hint}` : ""}: ${c.description}` : undefined}
                    onPointerMove={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      // Keep the caret in the composer.
                      e.preventDefault();
                      completeCommand(c);
                    }}
                  >
                    {menuKind === "skill" ? (
                      <IconSpark size={14} className="command-icon-skill" />
                    ) : menuKind === "prompt" ? (
                      <IconPlan size={14} className="command-icon-prompt" />
                    ) : (
                      <IconTerminal size={14} />
                    )}
                    <span className="command-name">{menuKind === "skill" ? `$${skillName(c)}` : menuKind === "prompt" ? `#${c.name}` : `/${c.name}`}</span>
                    {c.description ? <span className="command-desc">{c.description}</span> : null}
                    {menuKind === "slash" && (c.source === "skill" || c.source === "prompt" || c.source === "app") ? <span className="command-source">{c.source}</span> : null}
                  </div>
                ))
              )}
              {menuKind === "prompt" ? (
                <button
                  type="button"
                  className="command-foot command-foot-btn"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    managePrompts();
                  }}
                >
                  Manage saved prompts…
                </button>
              ) : null}
              {/* Where the skills went: under "$", unless the query already asks for them. */}
              {menuKind === "slash" && skillCount > 0 && !(slashQuery ?? "").toLowerCase().startsWith("skill") ? (
                <div className="command-foot" aria-hidden="true">
                  <IconSpark size={12} /> {skillCount} {skillCount === 1 ? "skill" : "skills"} under <kbd className="keycap">$</kbd>
                </div>
              ) : null}
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
            <div className="stash" ref={stashRef}>
              <button
                type="button"
                className="icon-btn composer-stash"
                aria-label={stash.length > 0 ? `Stash (${stash.length} kept)` : "Stash"}
                aria-haspopup="menu"
                aria-expanded={stashOpen}
                title="Stash this draft for later (Alt+S), or take a stashed one back"
                disabled={closed}
                onClick={() => {
                  setStash(loadStash());
                  setStashOpen((v) => !v);
                }}
              >
                <IconStash size={16} />
                {stash.length > 0 ? <span className="stash-count">{stash.length}</span> : null}
              </button>
              {stashOpen ? (
                <>
                  <div className="menu-backdrop" onClick={() => setStashOpen(false)} aria-hidden="true" />
                  <ul className="menu-list stash-menu" role="menu" aria-label="Stash" onKeyDown={(e) => e.key === "Escape" && setStashOpen(false)}>
                    <li role="none">
                      <button type="button" role="menuitem" disabled={empty && images.length === 0} onClick={stashNow}>
                        <IconStash size={14} /> Stash this draft <kbd>Alt+S</kbd>
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={empty}
                        onClick={() => {
                          setStashOpen(false);
                          managePrompts(text);
                        }}
                      >
                        <IconPlan size={14} /> Save the draft as a prompt…
                      </button>
                    </li>
                    {stash.length === 0 ? <li className="stash-empty muted">Nothing stashed</li> : null}
                    {stash.map((entry) => (
                      <li key={entry.id} role="none" className="stash-entry">
                        <button type="button" role="menuitem" className="stash-take" title={entry.text} onClick={() => unstash(entry.id)}>
                          <span className="stash-text">{entry.text.trim().split("\n")[0] || `${entry.images.length} image${entry.images.length === 1 ? "" : "s"}`}</span>
                          <span className="stash-meta muted">
                            {entry.from}
                            {entry.images.length > 0 ? (
                              <>
                                <Dot />
                                {`${entry.images.length} image${entry.images.length === 1 ? "" : "s"}`}
                              </>
                            ) : null}
                          </span>
                        </button>
                        <button type="button" className="icon-btn stash-drop" aria-label={`Drop stashed “${entry.text.trim().slice(0, 40)}”`} onClick={() => dropStashed(entry.id)}>
                          <IconX size={11} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
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
                  <span className="then-split">
                    <button
                      type="button"
                      className="pill-btn then-btn"
                      disabled={empty || tooLong}
                      title="Send this once the run is over, even with this page closed (Ctrl+Shift+Enter)"
                      onClick={() => void addThen()}
                    >
                      Then
                    </button>
                    <button type="button" className="pill-btn then-more" aria-label="Then hand off to…" aria-expanded={thenMenu} onClick={() => setThenMenu((v) => !v)}>
                      <IconChevronDown size={12} />
                    </button>
                    {thenMenu ? (
                      <>
                        <div className="menu-backdrop" onClick={() => setThenMenu(false)} aria-hidden="true" />
                        <ul className="menu-list then-menu" role="menu" aria-label="Then hand off to" onKeyDown={(e) => e.key === "Escape" && setThenMenu(false)}>
                          <li className="then-menu-head muted" role="none">
                            Once the run is over, hand off to…
                          </li>
                          {harnesses
                            .filter((h) => h.available && h.id !== chat.harnessId && h.id !== "awui")
                            .map((h, i) => (
                              <li key={h.id} role="none">
                                <button type="button" role="menuitem" autoFocus={i === 0} onClick={() => void addThen(h.id)}>
                                  {h.displayName}
                                  {text.trim() ? <span className="muted"> with this message</span> : null}
                                </button>
                              </li>
                            ))}
                        </ul>
                      </>
                    ) : null}
                  </span>
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
