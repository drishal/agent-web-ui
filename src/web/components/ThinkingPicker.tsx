// The thinking level, in the model picker's popover: the same pill, the same
// rows and check, opening on whichever side has room (a bottom sheet on
// phones). Levels come weakest first; each carries a small strength meter.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useDismiss } from "../hooks.js";
import { IconCheck, IconChevronDown } from "../icons.js";
import { clipBand } from "./ModelPicker.js";

export function ThinkingPicker({
  levels,
  current,
  disabled,
  onSelect,
}: {
  levels: string[];
  current: string | null;
  disabled: boolean;
  onSelect: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [below, setBelow] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  // "off" is no strength at all; the rest climb to full.
  const graded = levels.filter((l) => l !== "off");
  const strength = (level: string) => (level === "off" ? 0 : (graded.indexOf(level) + 1) / graded.length);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false), { escape: true });

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const band = clipBand(trigger.current);
    const room = rect.top - band.top - 16;
    setBelow(room < 40 + levels.length * 34 && band.bottom - rect.bottom > room);
    const at = levels.indexOf(current ?? "");
    setActive(at >= 0 ? at : 0);
    list.current?.focus();
    // Runs only when the picker opens.
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const choose = (level: string | undefined) => {
    if (level === undefined) return;
    close();
    if (level !== current) onSelect(level);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(i + 1, levels.length - 1)),
      ArrowUp: () => setActive((i) => Math.max(i - 1, 0)),
      Home: () => setActive(0),
      End: () => setActive(levels.length - 1),
      Enter: () => choose(levels[active]),
      " ": () => choose(levels[active]),
      Escape: () => close(),
    };
    if (e.key === "Tab") return close(false);
    const action = keys[e.key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };

  return (
    <div className="model-picker" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="pill-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Thinking: ${current ?? "default"}`}
        title="Thinking level"
        disabled={disabled}
        data-testid="thinking-picker"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          } else if (open) onKeyDown(e);
        }}
      >
        <span className="pill-label">{current ?? "default"}</span>
        <IconChevronDown size={12} />
      </button>
      {open ? (
        <>
          <div className="model-backdrop" aria-hidden="true" onClick={() => close(false)} />
          <div className={`model-pop is-compact${below ? " is-below" : ""}`}>
            <div
              ref={list}
              className="model-list"
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-label="Thinking"
              aria-activedescendant={`${listId}-${active}`}
              onKeyDown={onKeyDown}
            >
              <div className="model-group-head" aria-hidden="true">
                <span>Thinking</span>
              </div>
              {levels.map((level, i) => (
                <div
                  key={level}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={level === current}
                  className={`model-option${i === active ? " is-active" : ""}${level === current ? " is-current" : ""}`}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(level)}
                >
                  <span className="model-name">{level}</span>
                  <span className="thinking-meter" aria-hidden="true" style={{ ["--level" as string]: strength(level) }}>
                    <span />
                  </span>
                  <span className="model-check">{level === current ? <IconCheck size={13} /> : null}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
