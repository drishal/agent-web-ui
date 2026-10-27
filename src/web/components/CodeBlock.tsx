// A code block in an answer: a slim header with its language, Wrap (long lines
// wrap or scroll, remembered for the device), Copy on every one, and Run on a
// one-line shell block (T3 Code's), which runs it in the chat's project folder
// and shows the output under it, ready to add to the message. Once the answer
// has settled a block of a known language is coloured (highlight.ts) and a long
// one gets line numbers, drawn by CSS counters so they are never selected or
// copied; while it streams the text stays plain and the header is already
// there, so nothing moves but the one-time widening of a gutter at the end.
import { useContext, useMemo, useState, useSyncExternalStore } from "react";
import type { RunResult } from "../../shared/protocol.js";
import { gutterDigits, highlightLanguage, languageLabel, NUMBERED_FROM, richBlock, runnable } from "../code-blocks.js";
import { highlightLines } from "../highlight.js";
import { load, save } from "../storage.js";
import { api, errorText } from "../api.js";
import { addToDraft } from "../draft-bus.js";
import { IconCheck, IconCopy, IconTerminal, IconX, Spinner } from "../icons.js";
import { formatDuration } from "../turns.js";
import { ChatIdContext } from "./Subagents.js";
import { dotted } from "./Dot.js";

// The wrap choice is one per device, so every block on the page follows it.
const wrapListeners = new Set<() => void>();
const wrapNow = () => load<boolean>("codeWrap", false);
const setWrap = (on: boolean) => {
  save("codeWrap", on);
  for (const listener of wrapListeners) listener();
};
const onWrap = (listener: () => void) => {
  wrapListeners.add(listener);
  return () => void wrapListeners.delete(listener);
};

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

export function CodeBlock({ lang, code, children, allowRun, streaming = false }: { lang: string | null; code: string; children: React.ReactNode; allowRun: boolean; streaming?: boolean }) {
  const chatId = useContext(ChatIdContext);
  const wrap = useSyncExternalStore(onWrap, wrapNow, () => false);
  const label = languageLabel(lang);
  // Colours and numbers wait for the answer to settle (a block that grows would shift) and skip a huge block.
  const rows = useMemo(() => {
    if (streaming || !richBlock(code)) return null;
    return highlightLines(code.replace(/\n$/, ""), highlightLanguage(lang));
  }, [streaming, code, lang]);
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
    <div className={`code-block${wrap ? " is-wrapped" : ""}`}>
      <div className="code-head">
        {label ? <span className="code-lang">{label}</span> : null}
        <div className="code-actions">
          {run ? (
            <button type="button" className="code-action is-run" title={`Run in the project folder (${run.shell})`} disabled={state?.running} onClick={() => void start()}>
              {state?.running ? <Spinner size={12} /> : <IconTerminal size={13} />} Run
            </button>
          ) : null}
          <button type="button" className="code-action" aria-pressed={wrap} title={wrap ? "Scroll long lines sideways" : "Wrap long lines"} onClick={() => setWrap(!wrap)}>
            Wrap
          </button>
          <CopyButton text={code.replace(/\n$/, "")} label="Copy code" />
        </div>
      </div>
      {rows ? (
        <pre className={rows.length >= NUMBERED_FROM ? "has-numbers" : undefined} style={{ ["--digits" as string]: gutterDigits(rows.length) }}>
          <code className={lang ? `language-${lang}` : undefined}>
            {rows.map((tokens, i) => (
              <span key={i} className="cl">
                {tokens.map((t, k) =>
                  t.kind === "plain" ? (
                    t.text
                  ) : (
                    <span key={k} className={`tk-${t.kind}`}>
                      {t.text}
                    </span>
                  ),
                )}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <pre>{children}</pre>
      )}
      {state && !state.running ? (
        <div className={`run-output${result && result.exitCode !== 0 ? " is-failed" : ""}`} data-testid="run-output">
          <div className="run-head">
            <code className="run-cmd">$ {run?.command}</code>
            {result ? (
              <span className="run-meta">
                {dotted([status, formatDuration(result.durationMs), result.truncated ? "cut short" : null])}
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
