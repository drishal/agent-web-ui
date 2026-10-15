// A project path that opens the file viewer (file-bus.ts); a path outside the
// project stays plain text.
import { fileLinkable, openFile } from "../file-bus.js";

export function FileLink({ path, line, children, className }: { path: string; line?: number; children?: React.ReactNode; className?: string }) {
  if (!fileLinkable(path)) return <>{children ?? path}</>;
  return (
    <button
      type="button"
      className={`file-link${className ? ` ${className}` : ""}`}
      title={`Open ${path}${line ? ` at line ${line}` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        openFile(line ? { path, line } : { path });
      }}
    >
      {children ?? path}
    </button>
  );
}
