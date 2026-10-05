// The transcript, grouped into turns. Design borrowed (MIT) from:
//  - DeepSeek Harness: plain answers, user bubbles, the "Worked for …" process
//    fold, 24px disclosure rows, the I/O card, the turn rail;
//  - OpenCode: tool counts on the fold line, changed files per turn;
//  - Hermes Desktop: flat-not-boxed, pinned prompts, red only for failures.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssistantItem, ChatItem, ChatStatus, NoticeItem, RequestItem, ToolCategory, ToolItem, UserItem } from "../../shared/protocol.js";
import { IconCheck, IconChevronDown, IconCopy, IconEdit, IconFork, IconImage, IconInfo, IconSpark, IconWarning, IconX, Spinner, ToolIcon } from "../icons.js";
import { buildTurns, countSummary, formatDuration, relativePath, type Turn } from "../turns.js";
import { useNow } from "../hooks.js";
import { Markdown } from "./Markdown.js";
import { TurnRail } from "./TurnRail.js";

const PIN_DISTANCE_PX = 96;
const LONG_PROMPT_CHARS = 600;
const LONG_PROMPT_LINES = 8;

/** One quiet line that expands: icon (chevron on hover), title · summary. */
function DisclosureRow({
  icon,
  title,
  summary,
  tone,
  children,
  defaultOpen = false,
  testId,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  summary?: React.ReactNode;
  tone?: "error" | "warn";
  children?: React.ReactNode;
  defaultOpen?: boolean;
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
        {summary ? (
          <>
            <span className="drow-sep" aria-hidden="true" />
            <span className="drow-summary">{summary}</span>
          </>
        ) : null}
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
      testId="thought-row"
    >
      <div className="thought-body">{thinking}</div>
    </DisclosureRow>
  );
});

const ToolRow = memo(function ToolRow({ item, workspace }: { item: ToolItem; workspace: string }) {
  const failed = item.status === "error";
  const icon = item.status === "running" ? <Spinner size={13} /> : failed ? <IconX size={14} /> : <ToolIcon category={item.category} size={14} />;
  const summary = item.paths.length > 0 && item.summary === item.paths[0] ? relativePath(item.summary, workspace) : item.summary;
  return (
    <div className="tool-row" data-testid="tool-row" data-tool={item.name} data-status={item.status}>
      <DisclosureRow
        icon={icon}
        title={item.name}
        summary={
          <>
            {summary}
            {failed ? <span className="drow-suffix"> · failed</span> : null}
          </>
        }
        {...(failed ? { tone: "error" as const } : {})}
      >
        <div className="io-card">
          {item.args ? (
            <div className="io-section">
              <span className="io-label">Input</span>
              <pre className="io-text">{item.args}</pre>
            </div>
          ) : null}
          {item.args ? <div className="io-divider" /> : null}
          <div className="io-section">
            <span className="io-label">Output{item.truncated ? " (truncated)" : ""}</span>
            <pre className={`io-text${failed ? " is-error" : ""}`}>{item.output || (item.status === "running" ? "…" : "(no output)")}</pre>
          </div>
        </div>
      </DisclosureRow>
    </div>
  );
});

function NoticeRow({ item }: { item: NoticeItem }) {
  const icon = item.level === "error" ? <IconWarning size={14} /> : item.level === "warning" ? <IconWarning size={14} /> : <IconInfo size={14} />;
  return (
    <div className={`notice-row notice-${item.level}`} role={item.level === "error" ? "alert" : undefined}>
      <span className="notice-icon">{icon}</span>
      <span className="notice-text">{item.text}</span>
    </div>
  );
}

function RequestRow({ item }: { item: RequestItem }) {
  const outcome = item.outcome ?? "Waiting for you…";
  const tone = /Denied|Cancelled|Dismissed/.test(outcome) ? "warn" : undefined;
  return (
    <div className="request-row" data-testid="request-row">
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

function ProcessItem({ item, workspace }: { item: ChatItem; workspace: string }) {
  switch (item.kind) {
    case "assistant":
      return (
        <>
          {item.thinking ? <ThoughtRow thinking={item.thinking} streaming={item.streaming && !item.text} /> : null}
          {item.text ? (
            <div className="process-text">
              <Markdown text={item.text} />
            </div>
          ) : null}
        </>
      );
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

function UserPrompt({ item }: { item: UserItem }) {
  const long = item.text.length > LONG_PROMPT_CHARS || item.text.split("\n").length > LONG_PROMPT_LINES;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="turn-prompt">
      <div className="bubble-stack">
        <div className={`bubble${long && !expanded ? " is-clamped" : ""}`} data-testid="user-prompt">
          {item.text}
        </div>
        {item.imageCount ? (
          <span className="bubble-meta bubble-images">
            <IconImage size={13} /> {item.imageCount} {item.imageCount === 1 ? "image" : "images"}
          </span>
        ) : null}
        {long ? (
          <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Answer({ item, through, canFork, onFork }: { item: AssistantItem; through: number; canFork: boolean; onFork: (through: number) => void }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const stopped = item.error === "Stopped";
  return (
    <div className="answer" data-testid="answer">
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
}: {
  turn: Turn;
  open: boolean;
  onToggle: (id: string) => void;
  workspace: string;
  canFork: boolean;
  onFork: (through: number) => void;
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
      <UserPrompt item={turn.prompt} />
      {hasProcess ? <ProcessFold turn={turn} open={open} onToggle={onToggle} workspace={workspace} /> : null}
      {turn.answer ? <Answer item={turn.answer} through={turn.through} canFork={canFork && turn.through > 0} onFork={onFork} /> : null}
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
  items,
  status,
  workspace,
  canFork,
  onFork,
}: {
  items: ChatItem[];
  status: ChatStatus;
  workspace: string;
  canFork: boolean;
  onFork: (through: number) => void;
}) {
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

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distance <= PIN_DISTANCE_PX;
    setShowJump(!pinned.current);
  }, []);

  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setShowJump(false);
  }, []);

  useLayoutEffect(() => {
    if (pinned.current) {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
  }, [items]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    const inner = el.firstElementChild;
    if (inner) observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="conversation-wrap">
      <div className="conversation" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        <div className="thread">
          {turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} open={overrides[turn.id] ?? turn.live} onToggle={onToggle} workspace={workspace} canFork={canFork} onFork={fork} />
          ))}
        </div>
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
