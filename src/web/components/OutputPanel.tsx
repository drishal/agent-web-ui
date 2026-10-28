// A tool call's whole output in a sheet: the row's fold shows the head and tail of
// a long command, and this shows all of what the server kept (16 KB), live while
// the call is still running, with Copy.
import { IconCopy } from "../icons.js";
import { CopyButton } from "./CopyButton.js";
import { Dialog } from "./Dialog.js";

export function OutputPanel({ title, output, onClose }: { title: string; output: string; onClose: () => void }) {
  return (
    <Dialog title={`Output · ${title}`} onClose={onClose} className="output-panel">
      <div className="output-head">
        <span className="muted">{output === "" ? "No output yet" : `${output.split("\n").length.toLocaleString()} lines`}</span>
        <CopyButton className="btn btn-small btn-ghost" label="Copy" text="Copy" icon={<IconCopy size={13} />} iconSize={13} onCopy={() => navigator.clipboard?.writeText(output)} />
      </div>
      <pre className="output-body">{output}</pre>
    </Dialog>
  );
}
