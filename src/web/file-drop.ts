// Files dropped on the composer that are not images: which of the project's own
// files each one is (by name: a browser never gives a dropped file's path), what
// stops one from being added to the project, and where its `@path` goes in the
// draft. Pure, so the decisions are unit-tested; Composer.tsx does the asking
// and the drawing.

/** The upload route's body limit (app.ts reads at most 8 MB). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** How many candidates the "which one?" note lists; the list the server sends is already short. */
export const MAX_CHOICES = 8;

/** The files of a drop or pick that go to the image path's opposite: the ones to reference. */
export function otherFiles(files: FileList | null | undefined): File[] {
  return files ? [...files].filter((f) => !f.type.startsWith("image/")) : [];
}

/** Whether a drag in flight carries something that is not an image (the browser shows types, not names, until the drop). */
export function hasOtherFiles(items: ArrayLike<{ kind: string; type: string }>): boolean {
  return Array.from(items).some((item) => item.kind === "file" && !item.type.startsWith("image/"));
}

/** What the card says while files are dragged over it. */
export function dropHint(items: ArrayLike<{ kind: string; type: string }>): string {
  return hasOtherFiles(items) ? "Drop images to attach, or files to reference" : "Drop images to attach";
}

export type NameMatch = { kind: "one"; path: string } | { kind: "many"; paths: string[] } | { kind: "none" };

/** The project's files (relative paths) whose own name is `name`: the one to reference, several to choose from, or none. */
export function matchProjectFile(name: string, files: string[]): NameMatch {
  const hits = files.filter((file) => file.slice(file.lastIndexOf("/") + 1) === name);
  const [first] = hits;
  if (first === undefined) return { kind: "none" };
  return hits.length === 1 ? { kind: "one", path: first } : { kind: "many", paths: hits };
}

/** Why a file cannot be added to the project, or null when it can (checked before any bytes leave the browser). */
export function uploadProblem(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `${file.name} is empty, or a folder: only files can be added`;
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB; a file added to the project can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;
  return null;
}

/** The question for files the project does not have. */
export function addQuestion(names: string[]): string {
  return names.length === 1 ? `${names[0]} is not in the project — Add it to the project?` : `${names.length} files are not in the project — Add them to the project?`;
}

/**
 * `ref` put into `text` over the selection `from`–`to`, set off by a space on each side
 * (a reference only becomes a chip after a space and before one), and where the caret goes after it.
 */
export function insertReference(text: string, from: number, to: number, ref: string): { text: string; caret: number } {
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${ref}${trail}`;
  // Past a space that was already there, so the next reference does not start with one.
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length + (trail === "" ? 1 : 0) };
}
