// A project path that opens the file viewer (file-bus.ts); a path outside the
// project stays plain text. Resting the mouse (or keyboard focus) on it shows
// the file's first lines in a preview card; touch skips that, since a tap
// already opens the viewer.
import { useId } from "react";
import { fileLinkable, openFile, previewWorkspaceId } from "../file-bus.js";
import { useHoverCard } from "../hover-card.js";
import { FilePreview } from "./FilePreview.js";

const PREVIEW_MS = 450;

export function FileLink({ path, line, children, className }: { path: string; line?: number; children?: React.ReactNode; className?: string }) {
  if (!fileLinkable(path)) return <>{children ?? path}</>;
  return (
    <LinkedFile path={path} {...(line ? { line } : {})} {...(className ? { className } : {})}>
      {children}
    </LinkedFile>
  );
}

function LinkedFile({ path, line, children, className }: { path: string; line?: number; children?: React.ReactNode; className?: string }) {
  const { anchor, show, hide } = useHoverCard(PREVIEW_MS);
  const id = useId();
  const workspace = anchor ? previewWorkspaceId() : null;
  return (
    <>
      <button
        type="button"
        className={`file-link${className ? ` ${className}` : ""}`}
        title={anchor && workspace ? undefined : `Open ${path}${line ? ` at line ${line}` : ""}`}
        aria-describedby={anchor && workspace ? id : undefined}
        // Only a mouse rests; a touch press may start a scroll.
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") show(e.currentTarget);
        }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(e) => {
          if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget);
        }}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          hide();
          openFile(line ? { path, line } : { path });
        }}
      >
        {children ?? path}
      </button>
      {anchor && workspace ? <FilePreview workspace={workspace} path={path} anchor={anchor} id={id} /> : null}
    </>
  );
}
