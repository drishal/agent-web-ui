// The transcript, grouped into turns. Design borrowed (MIT) from:
//  - DeepSeek Harness: plain answers, user bubbles, the "Worked for …" process
//    fold, 24px disclosure rows, the I/O card, the turn rail;
//  - OpenCode: tool counts on the fold line, changed files per turn;
//  - Hermes Desktop: flat-not-boxed, pinned prompts, red only for failures.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssistantItem, ChatItem, ChatStatus, ImageRef, NoticeItem, RequestItem, ToolCategory, ToolItem, UserItem } from "../../shared/protocol.js";
import { IconCheck, IconChevronDown, IconCopy, IconEdit, IconFork, IconImage, IconInfo, IconRefresh, IconSpark, IconUndo, IconWarning, IconX, Spinner, ToolIcon } from "../icons.js";
import { ago, buildTurns, countSummary, formatDuration, latestThought, modelName, modelSwitches, relativePath, saysSomething, type Turn } from "../turns.js";
import { useNow } from "../hooks.js";
import { Arrivals, ArrivalsContext, useArrival } from "../arrivals.js";
import { Markdown } from "./Markdown.js";
import { DiffBadge, ToolBody } from "./ToolBody.js";
import { AgentsCard, ChatIdContext, runsSummary } from "./Subagents.js";
import { ImageViewer, imageSize } from "./ImageViewer.js";
import { TurnRail } from "./TurnRail.js";

const PIN_DISTANCE_PX = 96;
const LONG_PROMPT_CHARS = 600;
const LONG_PROMPT_LINES = 8;

/** One quiet line that expands: icon (chevron on hover), title · summary. */
function DisclosureRow({
  icon,
  title,
  summary,
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
            <span className="drow-sep" aria-hidden="true" />
            <span className="drow-summary">{summary}</span>
          </>
        ) : null}
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

const ToolRow = memo(function ToolRow({ item, workspace }: { item: ToolItem; workspace: string }) {
  const failed = item.status === "error";
  const icon = item.status === "running" ? <Spinner size={13} /> : failed ? <IconX size={14} /> : <ToolIcon category={item.category} size={14} />;
  const summary = item.subagents ? runsSummary(item.subagents) : item.paths.length > 0 && item.summary === item.paths[0] ? relativePath(item.summary, workspace) : item.summary;
  const arrival = useArrival(item.id);
  // Seen running: its icon change (spinner to done) animates.
  const [live] = useState(item.status === "running");
  return (
    <div className={`tool-row${arrival}${live ? " is-live" : ""}`} data-testid="tool-row" data-tool={item.name} data-status={item.status}>
      <DisclosureRow
        icon={icon}
        title={item.name}
        summary={
          <>
            {summary}
            {failed ? <span className="drow-suffix"> · failed</span> : null}
          </>
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

/** Thinking and interim text between tool calls. */
function ProcessAssistant({ item }: { item: AssistantItem }) {
  const arrival = useArrival(item.id);
  const text = saysSomething(item.text);
  if (!text && !item.thinking.trim()) return null;
  return (
    <div className={`process-step${arrival}`}>
      {item.thinking.trim() ? <ThoughtRow thinking={item.thinking} streaming={item.streaming && !text} /> : null}
      {text ? (
        <div className="process-text">
          <Markdown text={item.text} />
        </div>
      ) : null}
    </div>
  );
}

export function ProcessItem({ item, workspace }: { item: ChatItem; workspace: string }) {
  switch (item.kind) {
    case "assistant":
      return <ProcessAssistant item={item} />;
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
  const arrival = useArrival(item.id);
  return (
    <div className={`turn-prompt${arrival}${editing ? " is-editing" : ""}`}>
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
          <div className={`bubble${long && !expanded ? " is-clamped" : ""}`} data-testid="user-prompt">
            {item.text}
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
  const stopped = item.error === "Stopped";
  const arrival = useArrival(item.id);
  return (
    <div className={`answer${arrival}`} data-testid="answer">
      {item.text ? <Markdown text={item.text} /> : null}
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
              <code>{f}</code>
            </li>
          ))}
        </ul>
      </DisclosureRow>
    </div>
  );
}

function ProcessFold({ turn, open, onToggle, workspace }: { turn: Turn; open: boolean; onToggle: (id: string) => void; workspace: string }) {
  const now = useNow(turn.live);
  const counts = countSummary(turn.counts);
  const duration =
    turn.startedAt !== undefined ? formatDuration((turn.live ? now : (turn.endedAt ?? turn.startedAt)) - turn.startedAt) : null;
  const label = turn.live ? "Working" : duration ? `Worked for ${duration}` : "Worked";
  const answerThinking = turn.answer?.thinking ? turn.answer : null;
  const thought = turn.live && !open ? latestThought(turn) : null;
  return (
    <div className={`process${open ? " is-open" : ""}${turn.live ? " is-live" : ""}`}>
      <button type="button" className="process-head" aria-expanded={open} onClick={() => onToggle(turn.id)} data-testid="process-toggle">
        {turn.live ? <Spinner size={13} /> : null}
        <span className="process-label">
          {label}
          {turn.live && duration ? <span className="process-time"> · {duration}</span> : null}
          {counts ? <span className="process-counts"> · {counts}</span> : null}
        </span>
        <IconChevronDown size={14} className="process-chevron" />
      </button>
      {thought ? (
        <div className="process-thought" data-testid="live-thought">
          <IconSpark size={13} />
          <span>{thought}</span>
        </div>
      ) : null}
      {open ? (
        <div className="process-body">
          {turn.process.map((item) => (
            <ProcessItem key={item.id} item={item} workspace={workspace} />
          ))}
          {answerThinking ? <ThoughtRow thinking={answerThinking.thinking} streaming={answerThinking.streaming && !answerThinking.text} /> : null}
        </div>
      ) : null}
    </div>
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
}) {
  if (!turn.prompt) {
    // Startup notices before any prompt: plain rows, no fold.
    return (
      <section className="turn turn-preamble">
        {[...turn.process, ...turn.errors, ...turn.after].map((item) => (
          <ProcessItem key={item.id} item={item} workspace={workspace} />
        ))}
      </section>
    );
  }
  const hasProcess = turn.process.length > 0 || Boolean(turn.answer?.thinking);
  return (
    <section className="turn" id={`turn-${turn.id}`} data-turn-id={turn.id} data-testid="turn">
      <UserPrompt item={turn.prompt} through={turn.through} canBranch={canBranch} hasCheckpoint={hasCheckpoint} actions={promptActions} />
      {hasProcess ? <ProcessFold turn={turn} open={open} onToggle={onToggle} workspace={workspace} /> : null}
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

  return (
    <div className="conversation-wrap" ref={wrap}>
      <div className="conversation" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        <ChatIdContext.Provider value={chatId}>
          <ArrivalsContext.Provider value={arrivals}>
            <div className="thread">
              {turns.map((turn) => (
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
                  />
                </Fragment>
              ))}
            </div>
          </ArrivalsContext.Provider>
        </ChatIdContext.Provider>
      </div>
      <TurnRail turns={turns} scroller={scroller} />
      {showJump ? (
        <button type="button" className="jump" onClick={jump}>
          Jump to latest <IconChevronDown size={14} />
        </button>
      ) : null}
    </div>
  );
}
