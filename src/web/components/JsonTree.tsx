// A JSON object or array as a collapsible tree (json-tree.ts makes the rows):
// keys and values in the code highlighter's colours, containers that fold with
// their counts, long strings cut with "…more". Copy hands back the raw JSON
// text, not what is drawn. Everything is text, never markup.
import { useMemo, useState } from "react";
import { flattenJson, MAX_NODES } from "../json-tree.js";

const KIND_CLASS = { object: "", array: "", string: "tk-string", number: "tk-number", boolean: "tk-literal", null: "tk-literal" } as const;

function toggle(set: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(path)) next.add(path);
  return next;
}

export function JsonTree({ value, raw, label }: { value: object; raw: string; label: string }) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [whole, setWhole] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const { rows, capped } = useMemo(() => flattenJson(value, toggled, whole), [value, toggled, whole]);
  return (
    <div className="json-tree" role="tree" aria-label={label}>
      <button
        type="button"
        className="json-copy"
        onClick={() =>
          void navigator.clipboard?.writeText(raw).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy JSON"}
      </button>
      {rows.map((r) => {
        const name = r.key === null ? null : <span className="tk-key json-key">{r.key}</span>;
        const body = (
          <>
            {r.foldable ? <span className="json-caret" aria-hidden="true">{r.open ? "▾" : "▸"}</span> : <span className="json-caret" aria-hidden="true" />}
            {name}
            {name ? <span className="json-colon">:</span> : null}
            <span className={r.kind === "object" || r.kind === "array" ? "json-count" : KIND_CLASS[r.kind]}>{r.preview}</span>
          </>
        );
        return (
          <div className="json-row" role="treeitem" aria-expanded={r.foldable ? r.open : undefined} key={r.path} style={{ paddingLeft: `${r.depth * 14}px` }}>
            {r.foldable ? (
              <button type="button" className="json-fold" aria-label={`${r.key ?? "root"}, ${r.preview}`} onClick={() => setToggled((t) => toggle(t, r.path))}>
                {body}
              </button>
            ) : (
              <span className="json-leaf">{body}</span>
            )}
            {r.more ? (
              <button type="button" className="json-more" onClick={() => setWhole((w) => toggle(w, r.path))}>
                …more
              </button>
            ) : null}
          </div>
        );
      })}
      {capped ? <div className="json-capped muted">Only the first {MAX_NODES} nodes are shown.</div> : null}
    </div>
  );
}
