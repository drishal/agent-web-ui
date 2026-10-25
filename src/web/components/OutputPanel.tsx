// A tool call's whole output in a sheet: the row's fold shows the head and tail of
// a long command, and this shows all of what the server kept (16 KB), live while
// the call is still running, with Copy.
import { useState } from "react";
import { IconCheck, IconCopy } from "../icons.js";
import { Dialog } from "./Dialog.js";

export function OutputPanel({ title, output, onClose }: { title: string; output: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title={`Output · ${title}`} onClose={onClose} className="output-panel">
      <div className="output-head">
        <span className="muted">{output === "" ? "No output yet" : `${output.split("\n").length.toLocaleString()} lines`}</span>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={() =>
            void navigator.clipboard?.writeText(output).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            })
          }
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="output-body">{output}</pre>
    </Dialog>
  );
}
