// Writing git from the git panel: stage and unstage the files `git status` lists,
// and commit what is staged. Commands run through git.ts, so no hooks, no
// fsmonitor, and no GIT_* from the server's environment; paths are the caller's,
// so each one must be a path the project's own status listed (a rename carries
// both names). Nothing here reads a credential or writes a config.
import type { GitStatus } from "../shared/protocol.js";
import { git } from "./git.js";
import { gitStatus } from "./git-status.js";

const MAX_PATHS = 200;
const WRITE = { timeoutMs: 30_000 };

/** A refusal the route turns into a ChatError. */
export class GitActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function cleanPath(raw: string): string {
  if (!raw || raw.length > 4096 || raw.includes("\0")) throw new GitActionError(400, "bad_path", "Name a file");
  const parts = raw.split("/");
  if (raw.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new GitActionError(400, "bad_path", "Paths are relative to the project");
  }
  return raw;
}

/** The paths as git needs them: each one listed by the status, plus a rename's old name. */
function checked(status: GitStatus, raw: string[]): string[] {
  if (raw.length === 0 || raw.length > MAX_PATHS) throw new GitActionError(400, "bad_paths", "Name between 1 and 200 files");
  const listed = new Map(status.files.map((file) => [file.path, file]));
  const out = new Set<string>();
  for (const raw_ of raw) {
    const path = cleanPath(raw_);
    const file = listed.get(path);
    if (!file) throw new GitActionError(400, "unknown_path", `${path} is not a changed file`);
    out.add(file.path);
    if (file.from) out.add(file.from);
  }
  return [...out];
}

async function statusOf(cwd: string): Promise<GitStatus> {
  const status = await gitStatus(cwd).catch(() => null);
  if (!status) throw new GitActionError(409, "not_a_repository", "This project is not in a git repository");
  return status;
}

/** `git add -A -- <paths>`: a deletion stages as a deletion, a new file as an addition. */
export async function stageFiles(cwd: string, paths: string[]): Promise<GitStatus> {
  const status = await statusOf(cwd);
  const list = checked(status, paths);
  await git(["--literal-pathspecs", "add", "-A", "--", ...list], { cwd, ...WRITE });
  return statusOf(cwd);
}

async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, ...WRITE });
    return true;
  } catch {
    return false;
  }
}

/** Take the paths back out of the index; before the first commit there is no HEAD to restore from. */
export async function unstageFiles(cwd: string, paths: string[]): Promise<GitStatus> {
  const status = await statusOf(cwd);
  const list = checked(status, paths);
  if (await hasHead(cwd)) await git(["--literal-pathspecs", "restore", "--staged", "--", ...list], { cwd, ...WRITE });
  else await git(["--literal-pathspecs", "rm", "--cached", "-r", "--quiet", "--", ...list], { cwd, ...WRITE });
  return statusOf(cwd);
}

/** Commit what is staged; git's own refusal (an unset identity, a hook-free commit failure) is the message. */
export async function commitStaged(cwd: string, message: string): Promise<GitStatus> {
  const text = message.trim();
  if (!text) throw new GitActionError(400, "empty_message", "Write a commit message");
  const status = await statusOf(cwd);
  if (status.counts.staged === 0) throw new GitActionError(409, "nothing_staged", "Stage a change before committing");
  try {
    await git(["commit", "--quiet", "-m", text], { cwd, ...WRITE });
  } catch (error) {
    throw new GitActionError(422, "commit_failed", error instanceof Error ? error.message : String(error));
  }
  return statusOf(cwd);
}
