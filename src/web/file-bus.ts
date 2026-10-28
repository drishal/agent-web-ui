// Open a project file in the viewer from anywhere on the page (a tool card's
// path, a turn's changed files, a review's file, a search result): the shell
// listens and shows it in the shown chat's project. A path outside the
// project is not offered (fileLinkable).
import { useEffect, useRef } from "react";

const EVENT = "awui:open-file";

export interface FileRequest {
  /** Relative to the project. */
  path: string;
  /** 1-based, to bring into view and mark. */
  line?: number;
}

export function openFile(request: FileRequest): void {
  window.dispatchEvent(new CustomEvent<FileRequest>(EVENT, { detail: request }));
}

export function useFileRequests(handler: (request: FileRequest) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<FileRequest>).detail);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}

/** Whether a path (already made relative to the project) is one the viewer can show: inside the project. */
export function fileLinkable(rel: string): boolean {
  return rel !== "" && !rel.startsWith("/") && rel !== ".." && !rel.startsWith("../");
}

// The project whose files a link names, for the hover preview (the link knows
// only a relative path). The shell sets it to the shown chat's project, the same
// one the viewer opens in.
let previewWorkspace: string | null = null;

export function setPreviewWorkspace(id: string | null): void {
  previewWorkspace = id;
}

export function previewWorkspaceId(): string | null {
  return previewWorkspace;
}
