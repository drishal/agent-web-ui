// The transcript, grouped into turns. Design borrowed (MIT) from:
//  - DeepSeek Harness: plain answers, user bubbles, the "Worked for …" process
//    fold, 24px disclosure rows, the I/O card, the turn rail;
//  - OpenCode: tool counts on the fold line, changed files per turn;
//  - Hermes Desktop: flat-not-boxed, pinned prompts, red only for failures.
import { Fragment, memo, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssistantItem, ChatItem, ChatStatus, ImageRef, NoticeItem, RequestItem, ToolCategory, ToolItem, UserItem } from "../../shared/protocol.js";
import { IconCheck, IconChevronDown, IconChevronUp, IconCopy, IconEdit, IconFork, IconImage, IconInfo, IconLink, IconRefresh, IconSearch, IconSpark, IconUndo, IconWarning, IconX, Spinner, ToolIcon } from "../icons.js";
import { promptLink } from "../prompt-link.js";
import { findOffsets, foldsToOpen, stepMatch } from "../find.js";
import { ago, buildTurns, countSummary, formatDuration, latestThought, modelName, modelSwitches, relativePath, saysSomething, toolLabel, type Turn, readsAsNarration, workSegments, type WorkSegment } from "../turns.js";
import { useNow } from "../hooks.js";
import { Dot } from "./Dot.js";
import { Rolling } from "./Rolling.js";
import { Arrivals, ArrivalsContext, useArrival } from "../arrivals.js";
import { Markdown } from "./Markdown.js";
import { QuoteButton } from "./QuoteButton.js";
import { addToDraft, asQuote, quoteParts } from "../draft-bus.js";
import { useLongPress } from "../gestures.js";
import { ActionSheet, type SheetAction } from "./ActionSheet.js";
import { DiffBadge, ToolBody } from "./ToolBody.js";
import { FileLink } from "./FileLink.js";
import { HtmlRenderFrame } from "./HtmlRenderFrame.js";
import { AgentsCard, ChatIdContext, runsSummary } from "./Subagents.js";
import { ImageViewer, imageSize } from "./ImageViewer.js";
import { TurnRail } from "./TurnRail.js";
import { IMPLEMENT_TEXT, PlanCard } from "./PlanCard.js";

const PIN_DISTANCE_PX = 96;
/**
 * A chat opens at its end: the last few turns are drawn at once, and the older
 * ones go in above them a batch at a time (a transition, so typing and clicks
 * win), out of sight while the view sits at the bottom. A long session then
 * shows in a frame instead of after every turn's Markdown has been laid out.
 */
const FIRST_TURNS = 6;
const MORE_TURNS = 12;
const LONG_PROMPT_CHARS = 600;
const LONG_PROMPT_LINES = 8;

/** One quiet line that expands: icon (chevron on hover), title · summary. */
function DisclosureRow({
  icon,
  title,
  summary,
  after,
  aside,
  tone,
  children,
  defaultOpen = false,
  hideSummaryWhenOpen = false,
  testId,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  summary?: React.ReactNode;
  /** Kept whole right after the summary (a call's time), however long the summary. */
  after?: React.ReactNode;
  /** Kept whole at the end of the line (a diff count), however long the summary. */
  aside?: React.ReactNode;
  tone?: "error" | "warn";
  children?: React.ReactNode;
  defaultOpen?: boolean;
  /** The summary previews the body (thought's first line): hide it once open. */
  hideSummaryWhenOpen?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = children !== undefined && children !== null && children !== false;
  return (
    <div className={`drow${open ? " is-open" : ""}${tone ? ` tone-${tone}` : ""}`} data-testid={testId}>
      <button
        type="button"
        className="drow-head"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="drow-lead">
          <span className="drow-icon">{icon}</span>
          {expandable ? (
            <span className="drow-chevron">
              <IconChevronDown size={14} />
            </span>
          ) : null}
        </span>
        <span className="drow-title">{title}</span>
        {summary && !(open && hideSummaryWhenOpen) ? (
          <>
            <Dot />
            <span className="drow-summary">{summary}</span>
          </>
        ) : null}
        {after ? <span className="drow-after">{after}</span> : null}
        {aside ? <span className="drow-aside">{aside}</span> : null}
      </button>
      {open && expandable ? <div className="drow-body">{children}</div> : null}
    </div>
  );
}

function firstLine(text: string): string {
  return text.trim().split("\n").find((l) => l.trim()) ?? "";
}

const ThoughtRow = memo(function ThoughtRow({ thinking, streaming }: { thinking: string; streaming: boolean }) {
  return (
    <DisclosureRow
      icon={streaming ? <Spinner size={13} /> : <IconSpark size={14} />}
      title={streaming ? "Thinking" : "Thought"}
      summary={<span className="drow-prose">{firstLine(thinking)}</span>}
      hideSummaryWhenOpen
      testId="thought-row"
    >
      <div className="thought-body">{thinking}</div>
    </DisclosureRow>
  );
});

/** A call shows its time only once it has run this long — a flash of "1s" on a
 *  200ms call is noise, not feedback (neat-render does the same). */
const TIMER_AFTER_MS = 1500;
const ToolRow = memo(function ToolRow({ item, workspace }: { item: ToolItem; workspace: string }) {
  const failed = item.status === "error";
  const running = item.status === "running";
  // Stopwatch: ticks while the call runs and stays as the call's duration once
  // it settles, either only past TIMER_AFTER_MS.
  const now = useNow(running && item.at !== undefined);
  const elapsedMs = running && item.at !== undefined ? Math.max(0, now - item.at) : undefined;
  const tookMs = !running && item.at !== undefined && item.endedAt !== undefined ? item.endedAt - item.at : undefined;
  const ms = elapsedMs ?? tookMs;
  const time = ms !== undefined && ms >= TIMER_AFTER_MS ? formatDuration(ms) : null;
  const icon = item.status === "running" ? <Spinner size={13} /> : failed ? <IconX size={14} /> : <ToolIcon category={item.category} size={14} />;
  const summary = item.subagents ? runsSummary(item.subagents) : item.paths.length > 0 && item.summary === item.paths[0] ? relativePath(item.summary, workspace) : item.summary;
  const arrival = useArrival(item.id);
  // Seen running: its icon change (spinner to done) animates.
  const [live] = useState(item.status === "running");
  return (
    <div className={`tool-row${arrival}${live ? " is-live" : ""}`} data-testid="tool-row" data-tool={item.name} data-status={item.status}>
      <DisclosureRow
        icon={icon}
        title={toolLabel(item.name)}
        summary={
          <>
            {summary}
            {failed ? (
              <span className="drow-suffix">
                <Dot />
                failed
              </span>
            ) : null}
          </>
        }
        after={
          time ? (
            <span className="drow-time">
              <Dot />
              <Rolling text={time} />
            </span>
          ) : null
        }
        aside={item.diffStat ? <DiffBadge added={item.diffStat.added} removed={item.diffStat.removed} /> : null}
        {...(failed ? { tone: "error" as const } : {})}
        // Agents seen working start open, so their progress shows as it happens.
        defaultOpen={Boolean(item.subagents) && live}
      >
        {item.subagents ? (
          <AgentsCard item={item} renderItem={(it) => <ProcessItem item={it} workspace={workspace} />} />
        ) : (
          <ToolBody item={item} workspace={workspace} />
        )}
      </DisclosureRow>
    </div>
  );
});

function NoticeRow({ item }: { item: NoticeItem }) {
  const arrival = useArrival(item.id);
  const icon = item.level === "error" ? <IconWarning size={14} /> : item.level === "warning" ? <IconWarning size={14} /> : <IconInfo size={14} />;
  // An extension's message (a memory recall, say): just its label, opening to the full text.
  if (item.detail) {
    return (
      <div className={`notice-row notice-detail${arrival}`} data-testid="extension-message">
        <DisclosureRow icon={icon} title={item.title ?? "Extension"}>
          <pre className="thought-body">{item.detail}</pre>
        </DisclosureRow>
      </div>
    );
  }
  return (
    <div className={`notice-row notice-${item.level}${arrival}`} role={item.level === "error" ? "alert" : undefined}>
      <span className="notice-icon">{icon}</span>
      <span className="notice-text">{item.text}</span>
    </div>
  );
}

function RequestRow({ item }: { item: RequestItem }) {
  const arrival = useArrival(item.id);
  const outcome = item.outcome ?? "Waiting for you…";
  const tone = /Denied|Cancelled|Dismissed/.test(outcome) ? "warn" : undefined;
  return (
    <div className={`request-row${arrival}`} data-testid="request-row">
      <DisclosureRow
        icon={item.outcome ? (tone ? <IconX size={14} /> : <IconCheck size={14} />) : <Spinner size={13} />}
        title={item.request.kind === "confirm" || item.request.options?.includes("Approve") ? "Approval" : "Question"}
        summary={
          <>
            {firstLine(item.request.title)} <span className="request-outcome">→ {outcome}</span>
          </>
        }
        {...(tone ? { tone } : {})}
      >
        <pre className="thought-body">{[item.request.title, item.request.message].filter(Boolean).join("\n\n")}</pre>
      </DisclosureRow>
    </div>
  );
}

/** Thinking and interim text between tool calls. Pure thought stays in the thought fold; a thinking blob that reads as narration and arrived after a tool renders as plain text. */
function ProcessAssistant({ item, afterTool, thoughtOnly = false }: { item: AssistantItem; afterTool: boolean; thoughtOnly?: boolean }) {
  const arrival = useArrival(item.id);
  // A reply between tool calls is drawn as a reply after its stretch of work; here only its thought.
  const text = !thoughtOnly && saysSomething(item.text);
  const thinking = item.thinking.trim();
  if (!text && !thinking) return null;
  const narrated = !text && afterTool && readsAsNarration(thinking);
  return (
    <div className={`process-step${arrival}`}>
      {thinking ? narrated ? (
        <div className="process-text">
          <Markdown text={thinking} />
        </div>
      ) : (
        <ThoughtRow thinking={thinking} streaming={item.streaming && !text} />
      ) : null}
      {text ? (
        <div className="process-text">
          <Markdown text={item.text} />
        </div>
      ) : null}
    </div>
  );
}

export function ProcessItem({ item, workspace, afterTool = false, thoughtOnly = false }: { item: ChatItem; workspace: string; afterTool?: boolean; thoughtOnly?: boolean }) {
  switch (item.kind) {
    case "assistant":
      return <ProcessAssistant item={item} afterTool={afterTool} thoughtOnly={thoughtOnly} />;
    case "tool":
      return <ToolRow item={item} workspace={workspace} />;
    case "notice":
      return <NoticeRow item={item} />;
    case "request":
      return <RequestRow item={item} />;
    default:
      return null;
  }
}

/** A prompt's images as numbered thumbnails, opening in the viewer. */
function SentImages({ images }: { images: ImageRef[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const [sizes, setSizes] = useState<Record<number, { width: number; height: number }>>({});
  const thumbs = useRef(new Map<number, HTMLElement>());
  const view = images.map((ref, i) => ({ src: `/api/images/${ref.id}`, width: sizes[i]?.width ?? null, height: sizes[i]?.height ?? null }));
  return (
    <>
      <ul className={`sent-images${images.length === 1 ? " is-single" : ""}`} aria-label="Images">
        {images.map((ref, i) => {
          const size = imageSize(view[i] as { width: number | null; height: number | null });
          return (
            <li key={`${i}:${ref.id}`} className="sent-image">
              <button
                type="button"
                className="sent-image-open"
                aria-label={`View image #${i + 1}`}
                ref={(el) => {
                  if (el) thumbs.current.set(i, el);
                  else thumbs.current.delete(i);
                }}
                onClick={() => setViewing(i)}
              >
                <img
                  src={view[i]?.src}
                  alt={`Image #${i + 1}`}
                  loading="lazy"
                  onLoad={(e) => {
                    const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
                    setSizes((s) => (s[i] ? s : { ...s, [i]: { width, height } }));
                  }}
                />
              </button>
              <span className="image-label" aria-hidden="true">
                <strong>#{i + 1}</strong>
                {size ? <span>{size}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {viewing !== null ? <ImageViewer images={view} start={viewing} thumbnail={(i) => thumbs.current.get(i) ?? null} onClose={() => setViewing(null)} /> : null}
    </>
  );
}

/** Retry and Edit replace a prompt in place (where the harness can), else branch from before it; App does the work. */
export interface PromptActions {
  /** The chat replaces prompts in place rather than branching. */
  inPlace: boolean;
  retry: (through: number, item: UserItem) => void;
  /** Resolves true once the edited prompt went out (the editor then closes). */
  edit: (through: number, item: UserItem, text: string, undoFiles: boolean) => Promise<boolean>;
}

function PromptEditor({
  item,
  hasCheckpoint,
  inPlace,
  onSend,
  onCancel,
}: {
  item: UserItem;
  hasCheckpoint: boolean;
  inPlace: boolean;
  onSend: (text: string, undoFiles: boolean) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(item.text);
  const [undoFiles, setUndoFiles] = useState(hasCheckpoint);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.5)}px`;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    if (!(await onSend(text, undoFiles))) setSending(false);
  };
  return (
    <div className="prompt-editor">
      <textarea
        ref={ref}
        className="prompt-editor-input"
        aria-label="Edit message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="prompt-editor-foot">
        {hasCheckpoint ? (
          <label className="prompt-editor-check">
            <input type="checkbox" checked={undoFiles} onChange={(e) => setUndoFiles(e.target.checked)} />
            Undo file changes from here too
          </label>
        ) : (
          <span className="prompt-editor-note">{inPlace ? "Replaces this message and everything after it" : "Sends as a new branch; this chat stays as it is"}</span>
        )}
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" onClick={() => void send()} disabled={sending || !text.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function UserPrompt({
  item,
  through,
  canBranch,
  hasCheckpoint,
  actions,
}: {
  item: UserItem;
  through: number;
  /** Retry and Edit are offered (the agent is idle, and the chat can branch here). */
  canBranch: boolean;
  hasCheckpoint: boolean;
  actions: PromptActions;
}) {
  const long = item.text.length > LONG_PROMPT_CHARS || item.text.split("\n").length > LONG_PROMPT_LINES;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sheet, setSheet] = useState(false);
  const press = useLongPress(() => setSheet(true));
  // A link that opens a new chat with this prompt ready to read and send (prompt-link.ts).
  const copyLink = () =>
    void navigator.clipboard?.writeText(promptLink(window.location.origin, item.text)).then(() => {
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    });
  const arrival = useArrival(item.id);
  // A long press on a phone: the hover actions as a sheet a thumb can use.
  const sheetActions: SheetAction[] = [
    ...(canBranch
      ? [
          { label: "Retry", icon: <IconRefresh size={16} />, run: () => actions.retry(through, item) },
          { label: "Edit", icon: <IconEdit size={16} />, run: () => setEditing(true) },
        ]
      : []),
    { label: "Copy", icon: <IconCopy size={16} />, run: () => void navigator.clipboard?.writeText(item.text) },
    { label: "Copy prompt link", icon: <IconLink size={16} />, run: copyLink },
  ];
  return (
    <div className={`turn-prompt${arrival}${editing ? " is-editing" : ""}`}>
      {sheet ? <ActionSheet title="Message" actions={sheetActions} onClose={() => setSheet(false)} /> : null}
      <div className="bubble-stack">
        {item.images?.length ? <SentImages images={item.images} /> : null}
        {editing ? (
          <PromptEditor
            item={item}
            hasCheckpoint={hasCheckpoint}
            inPlace={actions.inPlace}
            onCancel={() => setEditing(false)}
            onSend={async (text, undoFiles) => {
              const ok = await actions.edit(through, item, text, undoFiles);
              if (ok) setEditing(false);
              return ok;
            }}
          />
        ) : (
          <div className={`bubble${long && !expanded ? " is-clamped" : ""}`} data-testid="user-prompt" {...press}>
            {quoteParts(item.text).map((part, i) =>
              part.quote ? (
                <blockquote key={i} className="bubble-quote">
                  {part.text}
                </blockquote>
              ) : (
                <span key={i} className="bubble-text">
                  {part.text}
                </span>
              ),
            )}
          </div>
        )}
        {item.imageCount && item.imageCount > (item.images?.length ?? 0) ? (
          <span className="bubble-meta bubble-images">
            <IconImage size={13} /> {item.images?.length ? `+${item.imageCount - item.images.length} more` : `${item.imageCount} ${item.imageCount === 1 ? "image" : "images"}`}
          </span>
        ) : null}
        {long && !editing ? (
          <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        {!editing ? (
          <div className="prompt-actions" data-testid="prompt-actions">
            {item.at ? (
              <span className="prompt-time" title={new Date(item.at).toLocaleString()}>
                {ago(item.at)}
              </span>
            ) : null}
            {canBranch ? (
              <>
                <button
                  type="button"
                  className="ghost-icon"
                  aria-label="Retry"
                  title={actions.inPlace ? "Retry: run this again, replacing what followed (files stay as they are)" : "Retry: run this again as a new branch (files stay as they are)"}
                  onClick={() => actions.retry(through, item)}
                >
                  <IconRefresh size={14} />
                </button>
                <button
                  type="button"
                  className="ghost-icon"
                  aria-label="Edit"
                  title={actions.inPlace ? "Edit: change this and run it again, replacing what followed" : "Edit: change this and run it as a new branch"}
                  onClick={() => setEditing(true)}
                >
                  <IconEdit size={14} />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="ghost-icon"
              aria-label={copied ? "Copied" : "Copy message"}
              title="Copy"
              onClick={() => {
                void navigator.clipboard?.writeText(item.text).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </button>
            <button
              type="button"
              className="ghost-icon"
              aria-label={linkCopied ? "Link copied" : "Copy prompt link"}
              title="Copy a link that opens a new chat with this prompt, ready to send"
              onClick={copyLink}
            >
              {linkCopied ? <IconCheck size={14} /> : <IconLink size={14} />}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Answer({
  item,
  through,
  canFork,
  onFork,
  canRestore,
  onRestore,
}: {
  item: AssistantItem;
  through: number;
  canFork: boolean;
  onFork: (through: number) => void;
  /** The files as they were before this turn's prompt can be put back. */
  canRestore: boolean;
  onRestore: (through: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const press = useLongPress(() => {
    if (!item.streaming && item.text) setSheet(true);
  });
  const stopped = item.error === "Stopped";
  const arrival = useArrival(item.id);
  const sheetActions: SheetAction[] = [
    { label: "Copy", icon: <IconCopy size={16} />, run: () => void navigator.clipboard?.writeText(item.text) },
    // Selecting a passage to quote is fiddly on a phone; this quotes the whole reply.
    { label: "Quote in message", icon: <IconEdit size={16} />, run: () => addToDraft(asQuote(item.text)) },
    ...(canFork ? [{ label: "Fork from here", icon: <IconFork size={16} />, run: () => onFork(through) }] : []),
    ...(canRestore ? [{ label: "Undo file changes from here", icon: <IconUndo size={16} />, run: () => onRestore(through) }] : []),
  ];
  return (
    <div className={`answer${arrival}`} data-testid="answer" {...press}>
      {sheet ? <ActionSheet title="Reply" actions={sheetActions} onClose={() => setSheet(false)} /> : null}
      {item.text ? <Markdown text={item.text} allowRun={!item.streaming} /> : null}
      {item.streaming && !item.text ? <span className="typing" aria-label="Writing">…</span> : null}
      {stopped ? <span className="stopped-pill">Stopped</span> : null}
      {item.error && !stopped ? <p className="answer-error">{item.error}</p> : null}
      {!item.streaming && item.text ? (
        <div className="answer-actions">
          <button
            type="button"
            className="ghost-icon"
            aria-label={copied ? "Copied" : copyFailed ? "Copy failed" : "Copy reply"}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(item.text)
                .then(() => {
                  setCopyFailed(false);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => {
                  setCopied(false);
                  setCopyFailed(true);
                  window.setTimeout(() => setCopyFailed(false), 1500);
                });
            }}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
          {canFork ? (
            <button
              type="button"
              className="ghost-icon"
              aria-label="Fork from here"
              title="Fork from here"
              onClick={() => onFork(through)}
            >
              <IconFork size={14} />
            </button>
          ) : null}
          {canRestore ? (
            <button
              type="button"
              className="ghost-icon"
              aria-label="Undo file changes from here"
              title="Undo file changes from this turn on"
              onClick={() => onRestore(through)}
            >
              <IconUndo size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChangedFiles({ files, workspace }: { files: string[]; workspace: string }) {
  const rel = files.map((f) => relativePath(f, workspace));
  return (
    <div className="changed-files" data-testid="changed-files">
      <DisclosureRow
        icon={<IconEdit size={14} />}
        title={`Changed ${files.length} file${files.length === 1 ? "" : "s"}`}
        summary={rel.slice(0, 3).join(", ") + (rel.length > 3 ? ` +${rel.length - 3}` : "")}
      >
        <ul className="changed-list">
          {rel.map((f) => (
            <li key={f}>
              <FileLink path={f}>
                <code>{f}</code>
              </FileLink>
            </li>
          ))}
        </ul>
      </DisclosureRow>
    </div>
  );
}

/**
 * The fold over a turn's work: the whole turn's when no reply came between tool
 * calls, else one stretch of it (`segment`, at `place` among them). The first
 * stretch carries how long the turn took; the last, while the turn runs, the
 * spinner and the live thought; the others name what they ran.
 */
function ProcessFold({
  turn,
  open,
  onToggle,
  workspace,
  segment,
  place,
}: {
  turn: Turn;
  open: boolean;
  onToggle: (id: string) => void;
  workspace: string;
  segment?: WorkSegment;
  place?: "first" | "middle" | "last";
}) {
  const live = turn.live && (place === undefined || place === "last");
  const now = useNow(live);
  const items = segment?.items ?? turn.process;
  const answerAt = segment ? segment.answerAt : turn.answerAt;
  const counts = countSummary(segment?.counts ?? turn.counts);
  const duration =
    turn.startedAt !== undefined ? formatDuration((turn.live ? now : (turn.endedAt ?? turn.startedAt)) - turn.startedAt) : null;
  const leading = place === undefined || place === "first";
  const label = live ? "Working" : leading ? (duration ? `Worked for ${duration}` : "Worked") : counts ? counts.charAt(0).toUpperCase() + counts.slice(1) : "Worked";
  const answerThinking = answerAt >= 0 && turn.answer?.thinking ? turn.answer : null;
  const thought = live && !open ? latestThought(turn) : null;
  return (
    <div className={`process${open ? " is-open" : ""}${live ? " is-live" : ""}`}>
      <button type="button" className="process-head" aria-expanded={open} onClick={() => onToggle(turn.id)} data-testid="process-toggle">
        <IconChevronDown size={14} className="process-chevron" />
        {live ? <Spinner size={13} /> : null}
        <span className="process-label">
          {label}
          {live && duration ? (
            <span className="process-time">
              <Dot />
              <Rolling text={duration} />
            </span>
          ) : null}
          {counts && (live || leading) ? (
            <span className="process-counts">
              <Dot />
              {counts}
            </span>
          ) : null}
        </span>
      </button>
      {thought ? (
        <div className="process-thought" data-testid="live-thought">
          <IconSpark size={13} />
          <span>{thought}</span>
        </div>
      ) : null}
      {open ? (
        <div className="process-body">
          {(() => {
            // The answer's own thought sits where the answer came, before any work that followed it.
            const answerThought = answerThinking ? <ThoughtRow thinking={answerThinking.thinking} streaming={answerThinking.streaming && !answerThinking.text} /> : null;
            let seenTool = false;
            return (
              <>
                {items.map((item, i) => {
                  const afterTool = seenTool;
                  if (item.kind === "tool") seenTool = true;
                  return (
                    <Fragment key={item.id}>
                      {i === answerAt ? answerThought : null}
                      <ProcessItem item={item} workspace={workspace} afterTool={afterTool} thoughtOnly={segment !== undefined} />
                    </Fragment>
                  );
                })}
                {answerAt >= items.length ? answerThought : null}
              </>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}

/** A reply the agent wrote between tool calls: the answer's look, without the answer's actions (those are the turn's). */
function InterimReply({ item }: { item: AssistantItem }) {
  const arrival = useArrival(item.id);
  return (
    <div className={`answer answer-interim${arrival}`} data-testid="interim-reply">
      <Markdown text={item.text} allowRun={!item.streaming} />
    </div>
  );
}

/**
 * A turn whose replies came between tool calls, in order: each stretch of work
 * folded (or, when it is only thinking, its thought rows as they are), then the
 * reply after it. All the stretches open and close together.
 */
function SegmentedWork({ turn, segments, open, onToggle, workspace }: { turn: Turn; segments: WorkSegment[]; open: boolean; onToggle: (id: string) => void; workspace: string }) {
  // While the turn runs on after a reply, a live fold follows it for what comes next.
  const ended = segments[segments.length - 1]?.reply !== null;
  const all: WorkSegment[] = turn.live && ended ? [...segments, { key: `${turn.id}#live`, items: [], reply: null, counts: {}, answerAt: -1 }] : segments;
  const lastIndex = all.length - 1;
  const live = (n: number) => turn.live && n === lastIndex;
  const shape = all.map((segment, n) =>
    segment.items.length === 0 && !live(n) ? "none" : segment.items.every((item) => item.kind === "assistant") && !live(n) ? "thought" : "fold",
  );
  // The first fold carries how long the turn took, the live one the spinner.
  const firstFold = shape.indexOf("fold");
  return (
    <>
      {all.map((segment, n) => {
        const place = live(n) ? "last" : n === firstFold ? "first" : "middle";
        const work =
          shape[n] === "none" ? null : shape[n] === "thought" ? (
            <div className="process-inline">
              {segment.items.map((item) => (
                <ProcessItem key={item.id} item={item} workspace={workspace} thoughtOnly />
              ))}
              {segment.answerAt >= 0 && turn.answer?.thinking ? <ThoughtRow thinking={turn.answer.thinking} streaming={turn.answer.streaming && !turn.answer.text} /> : null}
            </div>
          ) : (
            <ProcessFold turn={turn} open={open} onToggle={onToggle} workspace={workspace} segment={segment} place={place} />
          );
        return (
          <Fragment key={segment.key}>
            {work}
            {segment.reply ? <InterimReply item={segment.reply} /> : null}
          </Fragment>
        );
      })}
    </>
  );
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Structural equality, so a streamed rebuild reuses the previous Turn object when nothing it renders changed. */
function turnUnchanged(a: Turn, b: Turn): boolean {
  const countKeys = Object.keys(a.counts) as ToolCategory[];
  return (
    a.id === b.id &&
    a.index === b.index &&
    a.through === b.through &&
    a.live === b.live &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.model === b.model &&
    a.prompt === b.prompt &&
    a.answer === b.answer &&
    sameArray(a.process, b.process) &&
    sameArray(a.errors, b.errors) &&
    sameArray(a.after, b.after) &&
    sameArray(a.changedFiles, b.changedFiles) &&
    countKeys.length === Object.keys(b.counts).length &&
    countKeys.every((key) => a.counts[key] === b.counts[key])
  );
}

const TurnView = memo(function TurnView({
  turn,
  open,
  onToggle,
  workspace,
  canFork,
  onFork,
  canRestore,
  onRestore,
  canBranch,
  hasCheckpoint,
  promptActions,
  onImplement,
}: {
  turn: Turn;
  open: boolean;
  onToggle: (id: string) => void;
  workspace: string;
  canFork: boolean;
  onFork: (through: number) => void;
  canRestore: boolean;
  onRestore: (through: number) => void;
  canBranch: boolean;
  hasCheckpoint: boolean;
  promptActions: PromptActions;
  /** The latest turn's plan can be acted on (idle, nothing asked): Implement sends it on. */
  onImplement: (() => void) | null;
}) {
  if (!turn.prompt) {
    // What comes before any prompt (startup notices, or what a compaction kept): plain rows, no fold, and the
    // reply among them in its place (buildTurns takes it out of the process, so it is drawn here or not at all).
    return (
      <section className="turn turn-preamble">
        {turn.process.slice(0, turn.answerAt).map((item) => (
          <ProcessItem key={item.id} item={item} workspace={workspace} />
        ))}
        {turn.answer ? <Answer item={turn.answer} through={turn.through} canFork={false} onFork={onFork} canRestore={false} onRestore={onRestore} /> : null}
        {[...turn.process.slice(turn.answerAt), ...turn.errors, ...turn.after].map((item) => (
          <ProcessItem key={item.id} item={item} workspace={workspace} />
        ))}
      </section>
    );
  }
  const hasProcess = turn.process.length > 0 || Boolean(turn.answer?.thinking);
  const chatId = useContext(ChatIdContext);
  const segments = hasProcess ? workSegments(turn) : [];
  const split = segments.some((segment) => segment.reply !== null);
  return (
    <section className="turn" id={`turn-${turn.id}`} data-turn-id={turn.id} data-testid="turn">
      <UserPrompt item={turn.prompt} through={turn.through} canBranch={canBranch} hasCheckpoint={hasCheckpoint} actions={promptActions} />
      {split ? (
        <SegmentedWork turn={turn} segments={segments} open={open} onToggle={onToggle} workspace={workspace} />
      ) : hasProcess ? (
        <ProcessFold turn={turn} open={open} onToggle={onToggle} workspace={workspace} />
      ) : null}
      {turn.renders.length > 0 && chatId !== null ? (
        <div className="turn-renders">
          {turn.renders.map((render) => (
            <HtmlRenderFrame key={render.id} chatId={chatId} render={render} />
          ))}
        </div>
      ) : null}
      {turn.plans.map((p) => (
        <PlanCard key={p.id} plan={p.plan} onImplement={onImplement} />
      ))}
      {turn.answer ? (
        <Answer item={turn.answer} through={turn.through} canFork={canFork && turn.through > 0} onFork={onFork} canRestore={canRestore} onRestore={onRestore} />
      ) : null}
      {!hasProcess && !turn.answer && turn.live ? (
        <div className="process is-live">
          <span className="process-head is-static">
            <Spinner size={13} />
            <span className="process-label">Working</span>
          </span>
        </div>
      ) : null}
      {turn.errors.map((item) => (
        <NoticeRow key={item.id} item={item} />
      ))}
      {turn.changedFiles.length > 0 && !turn.live ? <ChangedFiles files={turn.changedFiles} workspace={workspace} /> : null}
      {turn.after.length > 0 ? (
        <div className="turn-after">
          {turn.after.map((item) => (
            <NoticeRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </section>
  );
});

export function Conversation({
  chatId,
  items,
  status,
  workspace,
  canFork,
  onFork,
  checkpoints,
  onRestore,
  promptActions,
  models,
  onSend,
  asking = false,
  findRequest = null,
  pane = "main",
}: {
  chatId: string;
  items: ChatItem[];
  status: ChatStatus;
  workspace: string;
  canFork: boolean;
  onFork: (through: number) => void;
  /** Turns whose files can be put back as they were before the prompt. */
  checkpoints: number[];
  onRestore: (through: number) => void;
  promptActions: PromptActions;
  /** The chat's models, to name the one a turn switched to. */
  models: ReadonlyArray<{ key: string; id: string; name: string }>;
  /** Send a message as the user (a plan's Implement). */
  onSend?: (text: string) => void;
  /** The harness is asking something (an approval, a question): a plan's buttons wait. */
  asking?: boolean;
  /** Open Find with this word (a chat opened from Search every chat); each new `nonce` asks again. */
  findRequest?: { query: string; nonce: number; chatId: string } | null;
  /** Which pane it is in, with a chat beside the main one: Ctrl+F finds in the pane that has the focus (the main one otherwise). */
  pane?: "main" | "side";
}) {
  const [arrivals] = useState(() => new Arrivals());
  arrivals.update(chatId, items);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const cache = useRef(new Map<string, Turn>());
  const turns = useMemo(() => {
    const fresh = buildTurns(items, status);
    const previous = cache.current;
    const next = new Map<string, Turn>();
    const stable = fresh.map((turn) => {
      const kept = previous.get(turn.id);
      const result = kept !== undefined && turnUnchanged(kept, turn) ? kept : turn;
      next.set(turn.id, result);
      return result;
    });
    cache.current = next;
    return stable;
  }, [items, status]);
  const switches = useMemo(() => modelSwitches(turns), [turns]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  // Turns before `from` are not drawn yet; a new chat starts near its end.
  const [drawn, setDrawn] = useState({ chatId: "", from: 0 });
  let from = drawn.from;
  if (drawn.chatId !== chatId) {
    from = Math.max(0, turns.length - FIRST_TURNS);
    setDrawn({ chatId, from });
  }
  from = Math.min(from, Math.max(0, turns.length - FIRST_TURNS));
  useEffect(() => {
    if (from <= 0) return;
    const frame = window.requestAnimationFrame(() => startTransition(() => setDrawn((d) => (d.chatId === chatId ? { chatId, from: Math.max(0, d.from - MORE_TURNS) } : d))));
    return () => window.cancelAnimationFrame(frame);
  }, [from, chatId]);
  // The rail can aim at a turn not drawn yet: draw the rest, then go there.
  const revealing = useRef<string | null>(null);
  const reveal = useCallback(
    (id: string) => {
      revealing.current = id;
      setDrawn({ chatId, from: 0 });
    },
    [chatId],
  );
  useLayoutEffect(() => {
    const id = revealing.current;
    if (from > 0 || !id) return;
    revealing.current = null;
    document.getElementById(`turn-${id}`)?.scrollIntoView({ block: "start" });
  }, [from]);

  const onToggle = useCallback((id: string) => {
    setOverrides((prev) => {
      const turn = turnsRef.current.find((t) => t.id === id);
      const current = prev[id] ?? Boolean(turn?.live);
      return { ...prev, [id]: !current };
    });
  }, []);

  // App re-creates forkChat per render; keep a stable identity for memoized TurnViews.
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;
  const fork = useCallback((through: number) => onForkRef.current(through), []);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const restore = useCallback((through: number) => onRestoreRef.current(through), []);
  const idle = status === "idle" || status === "error";
  const actionsRef = useRef(promptActions);
  actionsRef.current = promptActions;
  const inPlace = promptActions.inPlace;
  const actions = useMemo<PromptActions>(
    () => ({ inPlace, retry: (t, i) => actionsRef.current.retry(t, i), edit: (t, i, text, undo) => actionsRef.current.edit(t, i, text, undo) }),
    [inPlace],
  );
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const implement = useCallback(() => sendRef.current?.(IMPLEMENT_TEXT), []);
  const lastTurn = turns[turns.length - 1];
  const canImplement = Boolean(onSend) && idle && !asking;

  // A smooth scroll aims at the scrollHeight of the moment it starts, and the
  // delta handler / ResizeObserver force-scrolling would cancel it, so while
  // one runs jumpingRef holds them off. It ends on scrollend (or once scrolling
  // has been still for a moment, for browsers without scrollend), or when the
  // user takes over with the wheel, pointer, or keys.
  const jumpingRef = useRef(false);
  const settleTimer = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);

  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // Land a glide; if the reply grew while it ran, cover the rest instantly.
  const settle = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    const el = scroller.current;
    if (!el || !jumpingRef.current) return;
    jumpingRef.current = false;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setShowJump(false);
  }, []);

  const armSettle = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(settle, 300);
  }, [settle]);

  const glide = useCallback(
    (el: HTMLDivElement) => {
      jumpingRef.current = true;
      pinned.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      armSettle();
    },
    [armSettle],
  );

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distance <= PIN_DISTANCE_PX;
    if (jumpingRef.current) armSettle();
    setShowJump(!pinned.current && !jumpingRef.current);
  }, [armSettle]);

  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setShowJump(false);
    if (reducedMotion()) {
      el.scrollTop = el.scrollHeight;
      pinned.current = true;
    } else {
      glide(el);
    }
  }, [glide]);

  // Smooth scroll only when a new turn appears (the chat's "alive" beat);
  // token deltas and window resizes stay instant.
  const turnCountRef = useRef(0);

  // Another chat: it opens at its end, whatever this one was scrolled to, and settles in.
  const shownChat = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (shownChat.current === chatId) return;
    shownChat.current = chatId;
    pinned.current = true;
    jumpingRef.current = false;
    turnCountRef.current = turnsRef.current.length;
    setShowJump(false);
    const thread = scroller.current?.firstElementChild;
    if (thread && !reducedMotion()) {
      thread.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    }
  }, [chatId]);

  useLayoutEffect(() => {
    if (pinned.current) {
      const el = scroller.current;
      if (!el) return;
      const grew = turnsRef.current.length > turnCountRef.current;
      turnCountRef.current = turnsRef.current.length;
      if (jumpingRef.current) return;
      // Loading a transcript or switching tabs also adds turns; only a short
      // stretch (a turn just appended) is worth animating.
      const below = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (grew && below > 1 && below <= el.clientHeight && !reducedMotion()) {
        glide(el);
      } else {
        el.scrollTop = el.scrollHeight;
      }
    } else {
      turnCountRef.current = turnsRef.current.length;
      if (!jumpingRef.current) setShowJump(true);
    }
  }, [items, glide]);

  useEffect(() => {
    const el = scroller.current;
    const outer = wrap.current;
    if (!el || !outer) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current && !jumpingRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    const inner = el.firstElementChild;
    if (inner) observer.observe(inner);
    // Listen on the wrap so a turn-rail click also takes over from a glide.
    const takeOver = () => {
      jumpingRef.current = false;
    };
    outer.addEventListener("wheel", takeOver, { passive: true });
    outer.addEventListener("pointerdown", takeOver);
    outer.addEventListener("keydown", takeOver);
    el.addEventListener("scrollend", settle);
    return () => {
      observer.disconnect();
      outer.removeEventListener("wheel", takeOver);
      outer.removeEventListener("pointerdown", takeOver);
      outer.removeEventListener("keydown", takeOver);
      el.removeEventListener("scrollend", settle);
      window.clearTimeout(settleTimer.current);
    };
  }, [settle]);

  // ---- find in chat (find.ts) ----
  // Ctrl+F opens a find bar over the thread; pressed again while its box has the focus, the
  // browser's own find opens. A query draws every turn and opens the folds that hold a match,
  // then the drawn text is searched and painted with the CSS Custom Highlight API.
  const [find, setFind] = useState<{ query: string; current: number } | null>(null);
  const [matchCount, setMatchCount] = useState(0);
  const ranges = useRef<Range[]>([]);
  const findInput = useRef<HTMLInputElement>(null);
  const paint = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;
  const clearPaint = useCallback(() => {
    paint?.delete("awui-find");
    paint?.delete("awui-find-current");
  }, [paint]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== "KeyF") return;
      if (document.activeElement === findInput.current || (e.target as HTMLElement | null)?.closest("dialog")) return;
      const focused = (document.activeElement as HTMLElement | null)?.closest("[data-pane]")?.getAttribute("data-pane") ?? "main";
      if (focused !== pane) return;
      e.preventDefault();
      const picked = window.getSelection()?.toString().trim() ?? "";
      setFind((f) => f ?? { query: picked.includes("\n") ? "" : picked.slice(0, 100), current: -1 });
      window.requestAnimationFrame(() => {
        findInput.current?.focus();
        findInput.current?.select();
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pane]);
  // Asked from outside (Search every chat): the bar opens holding the word, and its first place comes into view.
  useEffect(() => {
    if (findRequest && findRequest.chatId === chatId) setFind({ query: findRequest.query, current: -1 });
  }, [findRequest?.nonce, chatId]);
  const query = find?.query.trim() ?? "";
  const [searched, setSearched] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setSearched(query), query ? 120 : 0);
    return () => window.clearTimeout(t);
  }, [query]);
  // A query reaches what is not drawn or folded: every turn, and the folds holding a match.
  useEffect(() => {
    if (!searched) return;
    setDrawn((d) => (d.chatId === chatId && d.from === 0 ? d : { chatId, from: 0 }));
    const open = foldsToOpen(turnsRef.current, searched);
    if (open.length > 0) setOverrides((prev) => (open.every((id) => prev[id]) ? prev : { ...prev, ...Object.fromEntries(open.map((id) => [id, true])) }));
  }, [searched, chatId]);
  useEffect(() => {
    const thread = scroller.current?.querySelector(".thread");
    if (!searched || !thread) {
      ranges.current = [];
      setMatchCount(0);
      clearPaint();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const found: Range[] = [];
      const walker = document.createTreeWalker(thread, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('[aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let node = walker.nextNode(); node && found.length < 5000; node = walker.nextNode()) {
        for (const at of findOffsets(node.nodeValue ?? "", searched)) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + searched.length);
          found.push(range);
        }
      }
      ranges.current = found;
      setMatchCount(found.length);
      paint?.set("awui-find", new Highlight(...found));
      setFind((f) => (f ? { ...f, current: found.length === 0 ? -1 : Math.min(Math.max(f.current, 0), found.length - 1) } : f));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searched, from, overrides, items, clearPaint, paint]);
  // The current match: painted apart, and brought into view a third of the way down.
  const current = find?.current ?? -1;
  useEffect(() => {
    const range = current >= 0 ? ranges.current[current] : undefined;
    if (!range) {
      paint?.delete("awui-find-current");
      return;
    }
    paint?.set("awui-find-current", new Highlight(range));
    const el = scroller.current;
    if (!el) return;
    const box = range.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    if (box.top < view.top + 48 || box.bottom > view.bottom - 48) {
      pinned.current = false;
      jumpingRef.current = false;
      el.scrollTop += box.top - view.top - view.height / 3;
    }
  }, [current, matchCount, paint]);
  const closeFind = () => {
    setFind(null);
    clearPaint();
  };
  useEffect(() => () => clearPaint(), [clearPaint]);
  const step = (by: 1 | -1) => setFind((f) => (f ? { ...f, current: stepMatch(f.current, ranges.current.length, by) } : f));

  return (
    <div className="conversation-wrap" ref={wrap}>
      {find ? (
        <div className="find-bar" role="search" aria-label="Find in chat">
          <IconSearch size={13} />
          <input
            ref={findInput}
            className="find-input"
            type="search"
            aria-label="Find in chat"
            placeholder="Find in chat"
            value={find.query}
            onChange={(e) => setFind({ query: e.target.value, current: -1 })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="find-count" data-testid="find-count" aria-live="polite">
            {searched ? (matchCount > 0 ? `${current + 1} of ${matchCount}` : "No matches") : ""}
          </span>
          <button type="button" className="icon-btn" aria-label="Previous match" disabled={matchCount === 0} onClick={() => step(-1)}>
            <IconChevronUp size={14} />
          </button>
          <button type="button" className="icon-btn" aria-label="Next match" disabled={matchCount === 0} onClick={() => step(1)}>
            <IconChevronDown size={14} />
          </button>
          <button type="button" className="icon-btn" aria-label="Close find" onClick={closeFind}>
            <IconX size={12} />
          </button>
        </div>
      ) : null}
      <div className="conversation" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        <ChatIdContext.Provider value={chatId}>
          <ArrivalsContext.Provider value={arrivals}>
            <div className="thread">
              {(from > 0 ? turns.slice(from) : turns).map((turn) => (
                <Fragment key={turn.id}>
                  {switches.has(turn.id) ? (
                    <div className="model-switch" role="separator" data-testid="model-switch">
                      <span>Switched to {modelName(switches.get(turn.id) as string, models)}</span>
                    </div>
                  ) : null}
                  <TurnView
                    turn={turn}
                    open={overrides[turn.id] ?? turn.live}
                    onToggle={onToggle}
                    workspace={workspace}
                    canFork={canFork}
                    onFork={fork}
                    canRestore={idle && turn.through > 0 && checkpoints.includes(turn.through)}
                    onRestore={restore}
                    canBranch={idle && turn.through > 0 && (inPlace || turn.through === 1 || canFork)}
                    hasCheckpoint={turn.through > 0 && checkpoints.includes(turn.through)}
                    promptActions={actions}
                    onImplement={canImplement && turn === lastTurn && turn.plans.length > 0 ? implement : null}
                  />
                </Fragment>
              ))}
            </div>
          </ArrivalsContext.Provider>
        </ChatIdContext.Provider>
      </div>
      <QuoteButton scope={scroller} />
      <TurnRail turns={turns} scroller={scroller} onReveal={reveal} />
      {showJump ? (
        <button type="button" className="jump" onClick={jump}>
          Jump to latest <IconChevronDown size={14} />
        </button>
      ) : null}
    </div>
  );
}
