// The keyboard shortcuts, at a glance (? outside a text box, or Ctrl+/):
// every key the app answers, grouped, drawn as keycaps, with a box that
// narrows the list. The table is shortcuts.ts, which the palette's hints read
// too.
import { Fragment, useMemo, useState } from "react";
import { balanceColumns, filterShortcuts, keyCaps, onMac, type ShortcutGroup } from "../shortcuts.js";
import { IconSearch } from "../icons.js";
import { Dialog } from "./Dialog.js";

function Keys({ combo, mac }: { combo: string; mac: boolean }) {
  return (
    <span className="keys-combo">
      {keyCaps(combo, mac).map((cap, i) => (
        <kbd key={i} className="keycap">
          {cap}
        </kbd>
      ))}
    </span>
  );
}

function Group({ g, mac }: { g: ShortcutGroup; mac: boolean }) {
  return (
    <section className="keys-group" aria-label={g.title}>
      <h3>{g.title}</h3>
      <dl>
        {g.items.map((s) => (
          <div key={s.id} className="keys-row">
            <dt>{s.label}</dt>
            <dd>
              {s.keys.map((k, i) => (
                <Fragment key={k}>
                  {i > 0 ? <span className="keys-or">or</span> : null}
                  <Keys combo={k} mac={mac} />
                </Fragment>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const mac = onMac();
  const groups = useMemo(() => filterShortcuts(query, mac), [query, mac]);
  const columns = useMemo(() => balanceColumns(groups), [groups]);
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} className="keys-dialog">
      <label className="model-search keys-search">
        <IconSearch size={15} />
        <input
          autoFocus
          type="search"
          aria-label="Filter shortcuts"
          placeholder="Filter: send, tab, find…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape closes the sheet at once, rather than first clearing the box.
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </label>
      <div className="keys-groups">
        {columns.map((column, i) =>
          column.length > 0 ? (
            <div key={i} className="keys-col">
              {column.map((g) => (
                <Group key={g.title} g={g} mac={mac} />
              ))}
            </div>
          ) : null,
        )}
        {groups.length === 0 ? <p className="keys-empty muted">No shortcut matches “{query.trim()}”</p> : null}
      </div>
      <p className="keys-foot muted">
        Press <kbd className="keycap">?</kbd> outside a text box, or <Keys combo="Mod+/" mac={mac} /> anywhere.
      </p>
    </Dialog>
  );
}
