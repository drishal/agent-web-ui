// Session tabs above the conversation (Hermes Desktop's): one per open chat,
// harness-coloured, a working ring while it runs and a dot when a run
// finished out of sight. Closing a tab only hides it; the chat keeps running
// on the server. Keys: ←/→ (Home/End) move, Enter opens, Delete closes. The
// browser owns Ctrl+T/W/Tab, so the strip claims none of them.
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ChatStatus } from "../../shared/protocol.js";
import { harnessColor } from "../harness-colors.js";
import { IconPlus, IconX } from "../icons.js";
import { isBusy } from "../session-groups.js";
import type { Tab } from "../tabs.js";
import { WorkingRing } from "./WorkingRing.js";

export function TabStrip({
  tabs,
  active,
  statusOf,
  harnessName,
  onActivate,
  onClose,
  onNew,
  newDisabled,
}: {
  tabs: Tab[];
  active: number;
  /** A tab's chat status, when the server holds its chat. */
  statusOf: (tab: Tab) => ChatStatus | null;
  harnessName: (id: string) => string;
  onActivate: (index: number) => void;
  onClose: (index: number) => void;
  onNew: () => void;
  newDisabled: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);

  // Keep the shown tab in view when the strip overflows.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const focusTab = (i: number) => strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus();

  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const last = tabs.length - 1;
    const go = (j: number) => {
      e.preventDefault();
      focusTab(j);
    };
    if (e.key === "ArrowRight") go(i === last ? 0 : i + 1);
    else if (e.key === "ArrowLeft") go(i === 0 ? last : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(last);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(i);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onClose(i);
      focusTab(Math.min(i, last - 1));
    }
  };

  return (
    <div className="tab-strip">
      <div className="tab-list" role="tablist" aria-label="Open chats" ref={strip}>
        {tabs.map((tab, i) => {
          const status = statusOf(tab);
          const working = isBusy(status);
          const selected = i === active;
          const name = harnessName(tab.harnessId);
          return (
            <div
              key={tab.key}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={`session-tab${selected ? " is-active" : ""}${tab.unread ? " is-unread" : ""}`}
              style={harnessColor(tab.harnessId)}
              title={`${tab.title} · ${name}`}
              onClick={() => onActivate(i)}
              onMouseDown={(e) => {
                // Middle-click closes; stop the browser's autoscroll from starting.
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose(i);
              }}
              onKeyDown={(e) => onKey(e, i)}
            >
              {working ? <WorkingRing harnessId={tab.harnessId} colored /> : <span className="harness-dot" role="img" aria-label={name} />}
              <span className="session-tab-title">{tab.title}</span>
              {tab.unread ? <span className="session-tab-unread" role="img" aria-label="Finished while away" /> : null}
              <button
                type="button"
                className="session-tab-close"
                aria-label={`Close ${tab.title}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(i);
                }}
              >
                <IconX size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-btn tab-new" aria-label="New chat in a new tab" title="New chat in a new tab" disabled={newDisabled} onClick={onNew}>
        <IconPlus size={14} />
      </button>
    </div>
  );
}
