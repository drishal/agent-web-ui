// Git in the composer (Hermes Desktop's coding row): one line at the base of
// the status stack — branch, upstream sync, what changed — that opens a panel
// with the details: upstream, last commit, stashes, and every changed file by
// group, each opening to its diff against HEAD.
import { useEffect, useRef, useState } from "react";
import type { GitFileDiff, GitStatus } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { GROUP_LABEL, groupFiles, OPERATION_LABEL, stateLetter, type GroupedFile } from "../git.js";
import { ago } from "../turns.js";
import { useNow } from "../hooks.js";
import { IconBranch, IconCheck, IconChevronDown, IconChevronRight, IconRefresh, IconX } from "../icons.js";
import { DiffBadge, DiffView } from "./ToolBody.js";

function Sync({ git }: { git: GitStatus }) {
  if (!git.upstream) return <span className="git-sync is-none">not pushed</span>;
  if (git.ahead === 0 && git.behind === 0)
    return (
      <span className="git-sync is-even" title={`Even with ${git.upstream}`}>
        <IconCheck size={11} />
      </span>
    );
  return (
    <span className="git-sync" title={`${git.ahead} ahead of, ${git.behind} behind ${git.upstream}`}>
      {git.ahead > 0 ? <span>↑{git.ahead}</span> : null}
      {git.behind > 0 ? <span>↓{git.behind}</span> : null}
    </span>
  );
}

function Counts({ git }: { git: GitStatus }) {
  const { conflicts, staged, changed, untracked } = git.counts;
  if (git.files.length === 0) return <span className="git-count is-clean">clean</span>;
  return (
    <>
      {conflicts > 0 ? (
        <span className="git-count is-conflict" title={`${conflicts} conflicted`}>
          {conflicts}
          <span className="git-count-label"> {conflicts === 1 ? "conflict" : "conflicts"}</span>
        </span>
      ) : null}
      {staged > 0 ? (
        <span className="git-count is-staged" title={`${staged} staged`}>
          {staged}
          <span className="git-count-label"> staged</span>
        </span>
      ) : null}
      {changed > 0 ? (
        <span className="git-count is-changed" title={`${changed} changed, not staged`}>
          {changed}
          <span className="git-count-label"> changed</span>
        </span>
      ) : null}
      {untracked > 0 ? (
        <span className="git-count is-untracked" title={`${untracked} untracked`}>
          {untracked}
          <span className="git-count-label"> new</span>
        </span>
      ) : null}
    </>
  );
}

export function GitRow({ git, onOpen }: { git: GitStatus; onOpen: () => void }) {
  return (
    <button type="button" className="git-row" onClick={onOpen} data-testid="git-row" title="Git status: open for files and diffs">
      <IconBranch size={14} className="git-branch-icon" />
      <span className="git-branch">{git.branch ?? `detached at ${git.head ?? "?"}`}</span>
      {git.operation ? <span className="git-op">{OPERATION_LABEL[git.operation]}</span> : null}
      <Sync git={git} />
      <span className="git-counts">
        <Counts git={git} />
      </span>
      <DiffBadge added={git.added} removed={git.removed} />
      <IconChevronRight size={13} className="git-open" />
    </button>
  );
}

function FileRow({ chatId, entry }: { chatId: string; entry: GroupedFile }) {
  const { file, state, lines, side } = entry;
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);

  const toggle = () => {
    setOpen(!open);
    if (!open && !diff) {
      api<GitFileDiff>(`/api/chats/${chatId}/git/diff?path=${encodeURIComponent(file.path)}&side=${side}`)
        .then(setDiff)
        .catch((e: unknown) => setError(errorText(e)));
    }
  };

  return (
    <li className={`git-file${open ? " is-open" : ""}`}>
      <button type="button" className="git-file-head" aria-expanded={open} onClick={toggle}>
        <IconChevronDown size={12} className="git-file-chevron" />
        <span className={`git-state is-${state}`} title={state}>
          {stateLetter(state)}
        </span>
        <span className="git-file-path" title={file.from ? `${file.from} → ${file.path}` : file.path}>
          {file.from && side !== "unstaged" ? <span className="git-file-from">{file.from} → </span> : null}
          <span className="git-file-dir">{dir}</span>
          <span className="git-file-name">{name}</span>
        </span>
        {lines && lines.added !== null && lines.removed !== null ? (
          <DiffBadge added={lines.added} removed={lines.removed} />
        ) : (
          <span className="git-file-note">{state === "untracked" ? "new" : state === "conflict" ? "conflict" : lines ? "binary" : ""}</span>
        )}
      </button>
      {open ? (
        <div className="git-file-body">
          {error ? <p className="git-file-msg is-error">{error}</p> : null}
          {!diff && !error ? <p className="git-file-msg">Loading…</p> : null}
          {diff?.diff ? <DiffView diff={diff.diff} /> : null}
          {diff && !diff.diff ? <p className="git-file-msg">{diff.note ?? "No changes to show"}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function GitPanel({ chatId, git, at, onRefresh, onClose }: { chatId: string; git: GitStatus; at: number; onRefresh: () => Promise<void>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(true, 10_000);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  const { counts } = git;
  const groups = groupFiles(git.files);

  return (
    <dialog
      ref={ref}
      className="review git-sheet"
      aria-label="Git status"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="review-body">
        <header className="review-head">
          <div className="git-title">
            <h2>
              <IconBranch size={16} /> Git
            </h2>
            <p className="muted" title={git.root}>
              {git.root} · updated {ago(at, now)}
            </p>
          </div>
          <div className="git-head-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Refresh"
              title="Refresh"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void onRefresh().finally(() => setRefreshing(false));
              }}
            >
              <IconRefresh size={15} />
            </button>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <IconX size={16} />
            </button>
          </div>
        </header>
        <div className="review-files">
          <dl className="git-facts">
            <dt>Branch</dt>
            <dd>
              <code>{git.branch ?? `detached at ${git.head ?? "?"}`}</code>
              {git.operation ? <span className="git-op">{OPERATION_LABEL[git.operation]}</span> : null}
            </dd>
            <dt>Upstream</dt>
            <dd>
              {git.upstream ? (
                <>
                  <code>{git.upstream}</code>
                  <span className="git-fact-meta">
                    {git.ahead === 0 && git.behind === 0 ? "up to date" : `${git.ahead} ahead · ${git.behind} behind`}
                  </span>
                </>
              ) : (
                <span className="muted">none: this branch has not been pushed</span>
              )}
            </dd>
            <dt>Last commit</dt>
            <dd>
              {git.lastCommit ? (
                <span className="git-commit">
                  <code>{git.lastCommit.hash}</code>
                  <span className="git-commit-subject">{git.lastCommit.subject}</span>
                  <span className="git-fact-meta">
                    {git.lastCommit.author}, {ago(git.lastCommit.at, now)}
                  </span>
                </span>
              ) : (
                <span className="muted">no commits yet</span>
              )}
            </dd>
            <dt>Changes</dt>
            <dd>
              {git.files.length === 0 ? (
                <span className="muted">working tree clean</span>
              ) : (
                <span className="git-fact-counts">
                  {[
                    counts.conflicts ? `${counts.conflicts} conflicted` : "",
                    counts.staged ? `${counts.staged} staged` : "",
                    counts.changed ? `${counts.changed} changed` : "",
                    counts.untracked ? `${counts.untracked} untracked` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  <DiffBadge added={git.added} removed={git.removed} />
                </span>
              )}
            </dd>
            {git.stashes > 0 ? (
              <>
                <dt>Stashes</dt>
                <dd>{git.stashes}</dd>
              </>
            ) : null}
          </dl>
          {git.files.length === 0 ? (
            <p className="git-clean">
              <IconCheck size={14} /> Nothing to commit
            </p>
          ) : null}
          {groups.map(({ group, files }) => (
            <section key={group} className={`git-group is-${group}`}>
              <h3 className="git-group-head">
                {GROUP_LABEL[group]} <span className="git-group-count">{files.length}</span>
              </h3>
              <ul className="git-files">
                {files.map((entry) => (
                  <FileRow key={`${group}:${entry.file.path}`} chatId={chatId} entry={entry} />
                ))}
              </ul>
            </section>
          ))}
          {git.more > 0 ? <p className="muted git-more">and {git.more} more files</p> : null}
        </div>
      </div>
    </dialog>
  );
}
