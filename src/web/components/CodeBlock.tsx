// A code block in an answer: Copy on every one, and Run on a one-line shell
// block (T3 Code's), which runs it in the chat's project folder and shows
// the output under it, ready to add to the message.
import { useContext, useState } from "react";
import type { RunResult } from "../../shared/protocol.js";
import { runnable } from "../code-blocks.js";
import { api, errorText } from "../api.js";
import { addToDraft } from "../draft-bus.js";
import { IconCheck, IconCopy, IconTerminal, IconX, Spinner } from "../icons.js";
import { formatDuration } from "../turns.js";
import { ChatIdContext } from "./Subagents.js";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="code-action"
      aria-label={done ? "Copied" : label}
      title={label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

export function CodeBlock({ lang, code, children, allowRun }: { lang: string | null; code: string; children: React.ReactNode; allowRun: boolean }) {
  const chatId = useContext(ChatIdContext);
  const run = allowRun && chatId ? runnable(lang, code) : null;
  const [state, setState] = useState<{ running: boolean; result?: RunResult; error?: string } | null>(null);

  const start = async () => {
    if (!run || !chatId) return;
    setState({ running: true });
    try {
      setState({ running: false, result: await api<RunResult>(`/api/chats/${chatId}/run`, { body: run }) });
    } catch (e) {
      setState({ running: false, error: errorText(e) });
    }
  };

  const result = state?.result;
  const status = result ? (result.timedOut ? "timed out" : result.exitCode === 0 ? "exit 0" : result.exitCode === null ? "stopped" : `exit ${result.exitCode}`) : "";

  return (
    <div className="code-block">
      <div className="code-actions">
        {lang ? <span className="code-lang">{lang}</span> : null}
        {run ? (
          <button type="button" className="code-action is-run" title={`Run in the project folder (${run.shell})`} disabled={state?.running} onClick={() => void start()}>
            {state?.running ? <Spinner size={12} /> : <IconTerminal size={13} />} Run
          </button>
        ) : null}
        <CopyButton text={code.replace(/\n$/, "")} label="Copy code" />
      </div>
      <pre>{children}</pre>
      {state && !state.running ? (
        <div className={`run-output${result && result.exitCode !== 0 ? " is-failed" : ""}`} data-testid="run-output">
          <div className="run-head">
            <code className="run-cmd">$ {run?.command}</code>
            {result ? (
              <span className="run-meta">
                {status} · {formatDuration(result.durationMs)}
                {result.truncated ? " · cut short" : ""}
              </span>
            ) : null}
            {result ? (
              <>
                <CopyButton text={result.output} label="Copy output" />
                <button
                  type="button"
                  className="code-action"
                  title="Add the command and its output to your message"
                  onClick={() => addToDraft(`\`\`\`\n$ ${run?.command}\n${result.output.replace(/\n$/, "")}\n\`\`\`\n(${status})\n\n`)}
                >
                  Add to message
                </button>
              </>
            ) : null}
            <button type="button" className="code-action" aria-label="Close output" onClick={() => setState(null)}>
              <IconX size={12} />
            </button>
          </div>
          {state.error ? <pre className="run-text">{state.error}</pre> : <pre className="run-text">{result?.output || "(no output)"}</pre>}
        </div>
      ) : null}
    </div>
  );
}
