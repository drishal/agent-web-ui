// A file added to the open project: the raw bytes to the upload route, which
// takes new names only. Shared by the file viewer (a drop on it) and the
// composer (a dropped file the project does not have). api.ts sends JSON, so
// this one speaks fetch itself, and gives back the stored path.

/** An upload the server refused; 409 is "a file by that name is already there". */
export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function uploadToProject(workspaceId: string, file: File): Promise<string> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !body.path) throw new UploadError(res.status, body.error ?? `Upload failed (${res.status})`);
  return body.path;
}
