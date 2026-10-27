// The composer's text box with chips in the sentence: file references, line
// ranges, quoted passages, and long pastes drawn as small atomic pills
// (draft-chips.ts), everything else as typed. The draft stays a plain string, the composer's own
// state, and this is a view of it: the box is contenteditable, but its content
// is drawn here from the string (not by React, which would fight the caret), and
// read back into the string on every edit. The handle answers like a textarea
// (value, selectionStart/End, setSelectionRange, focus), so the composer's keys,
// menus, recall, lists, blanks, and stash work on it unchanged. Enter, a paste,
// and a text drop insert plain text here, so the browser never adds markup. The
// redraw wipes the browser's undo stack, so the box keeps its own
// (draft-history.ts) and answers Ctrl/Cmd+Z, Shift+Z, Ctrl+Y, and the browser's
// historyUndo/historyRedo itself.
// A long paste (paste-ranges.ts) is one chip, yet its full text stays in the
// draft and goes out as typed: the box remembers where each paste sits and
// moves those ranges along with every edit (and through undo). A click on the
// chip (or Enter or Space on its label) turns it back into plain text, for good.
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { DraftHistory, type DraftSnap } from "../draft-history.js";
import { chipLabel, draftPieces, withoutPiece, type DraftPiece } from "../draft-chips.js";
import { addRange, isLongPaste, shiftRanges, shiftRangesDiff, usableRanges, type PasteRange } from "../paste-ranges.js";

/** What the composer reads and moves, as it did on its textarea. */
export interface ChipEditorHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
  readonly offsetHeight: number;
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  enterKeyHint?: React.HTMLAttributes<HTMLDivElement>["enterKeyHint"];
} & Pick<React.AriaAttributes, "aria-label" | "aria-autocomplete" | "aria-controls" | "aria-activedescendant">;

/** Holds the caret beside a chip at a line's end or start; not part of the text. */
const FILLER = "​";
const SVG = "http://www.w3.org/2000/svg";
/** The chips' icons, in icons.tsx's 16px stroke style (the box is drawn without React). */
const ICONS = {
  file: ["M4 1.75h5l3 3v9.5H4z", "M9 1.75v3h3M6 8h4M6 10.5h4"],
  lines: ["M3 4h10M3 8h10M3 12h6"],
  paste: ["M5.5 2.75h5v1.5h-5z", "M4 3.5H3.5v10.75h9V3.5H12", "M6 7.5h4M6 10h4"],
  quote: ["M3.5 11.5c1.6-.6 2.5-1.9 2.5-3.8V4.5H3v3.2h2.6", "M9.5 11.5c1.6-.6 2.5-1.9 2.5-3.8V4.5H9v3.2h2.6"],
  x: ["M4.5 4.5l7 7M11.5 4.5l-7 7"],
} as const;

function icon(paths: readonly string[], className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ class: `icon ${className}`, width: "13", height: "13", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) {
    svg.setAttribute(k, v);
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function chipNode(piece: Exclude<DraftPiece, { kind: "text" }>, before: readonly DraftPiece[]): HTMLElement {
  const { label, lines, title, linesOnly } = chipLabel(piece, before);
  const chip = document.createElement("span");
  chip.className = `draft-chip is-${piece.kind}${linesOnly ? " is-lines" : ""}`;
  chip.contentEditable = "false";
  chip.dataset.raw = piece.raw;
  chip.title = title;
  chip.appendChild(icon(piece.kind === "quote" ? ICONS.quote : piece.kind === "paste" ? ICONS.paste : linesOnly ? ICONS.lines : ICONS.file, "draft-chip-icon"));
  const name = document.createElement("span");
  name.className = "draft-chip-label";
  name.textContent = piece.kind === "quote" ? `“${label}”` : linesOnly ? lines : label;
  if (piece.kind === "paste") {
    // The chip is not a tab stop of the text, but its label is a button: Enter or Space puts the text back.
    chip.dataset.paste = String(piece.id);
    name.setAttribute("role", "button");
    name.tabIndex = 0;
    name.setAttribute("aria-label", `${label}: show the text`);
  }
  chip.appendChild(name);
  if (lines && !linesOnly) {
    const at = document.createElement("span");
    at.className = "draft-chip-lines";
    at.textContent = `:${lines}`;
    chip.appendChild(at);
  }
  const x = document.createElement("button");
  x.type = "button";
  x.className = "draft-chip-x";
  x.tabIndex = -1;
  x.setAttribute("aria-label", `Remove ${piece.kind === "quote" ? "the quote" : piece.kind === "paste" ? "the pasted text" : piece.raw.slice(1)}`);
  x.appendChild(icon(ICONS.x, ""));
  chip.appendChild(x);
  return chip;
}

/** The box's text: typed text as it is, a chip as its raw text, a line break as "\n", the caret's filler left out. */
function readText(root: Node): { text: string; flat: boolean } {
  let text = "";
  let flat = true;
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += (child.nodeValue ?? "").replaceAll(FILLER, "");
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.raw !== undefined) {
        text += child.dataset.raw;
      } else if (child.tagName === "BR") {
        if (child.dataset.end === undefined) {
          text += "\n";
          flat = false;
        }
      } else {
        // Markup the browser made (a pasted fragment, an IME's line): read through it, then redraw.
        flat = false;
        if ((child.tagName === "DIV" || child.tagName === "P") && text.length > 0 && !text.endsWith("\n")) text += "\n";
        walk(child);
      }
    }
  };
  walk(root);
  return { text, flat };
}

/** The chips drawn now, by their text: typing between them moves them but draws nothing again. */
function drawnChips(root: HTMLElement): string {
  return Array.from(root.children)
    .flatMap((c) => (c instanceof HTMLElement && c.dataset.raw !== undefined ? [c.dataset.raw] : []))
    .join("\u0000");
}

const chipsOf = (pieces: DraftPiece[]) =>
  pieces
    .flatMap((p) => (p.kind === "text" ? [] : [p.raw]))
    .join("\u0000");

export const ChipEditor = forwardRef<ChipEditorHandle, Props>(function ChipEditor(props, ref) {
  const { value, onChange, onKeyDown, onPaste, placeholder, disabled, className, style, enterKeyHint } = props;
  const box = useRef<HTMLDivElement>(null);
  const current = useRef(value);
  current.current = value;
  /** The value the user's own typing produced: a reference at the caret is still being typed then. */
  const typed = useRef<string | null>(null);
  /** Where the caret goes once a value set here has been drawn. */
  const pending = useRef<[number, number] | null>(null);
  const composing = useRef(false);
  const history = useRef(new DraftHistory());
  /** Where the draft's long pastes are, kept true as it changes; a chip shows each. */
  const pasteRanges = useRef<PasteRange[]>([]);
  const nextPasteId = useRef(1);
  /** Bumped when only the ranges changed (a chip turned back to text), so the box draws again. */
  const [shape, setShape] = useState(0);
  /** The draft as this editor last knew it: a different value arriving is the composer's own change. */
  const known = useRef(value);

  /** The text offset of a DOM point in the box. */
  const offsetOf = (node: Node, offset: number): number => {
    const root = box.current;
    if (!root) return 0;
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(node, offset);
    return readText(range.cloneContents()).text.length;
  };

  const selection = (): [number, number] => {
    const root = box.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return [current.current.length, current.current.length];
    const range = sel.getRangeAt(0);
    return [offsetOf(range.startContainer, range.startOffset), offsetOf(range.endContainer, range.endOffset)];
  };

  /** The DOM point for a text offset; one inside a chip snaps to its end. */
  const pointOf = (target: number): [Node, number] => {
    const root = box.current as HTMLDivElement;
    let at = 0;
    const kids = Array.from(root.childNodes);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as Node;
      if (child.nodeType === Node.TEXT_NODE) {
        const data = child.nodeValue ?? "";
        const len = data.replaceAll(FILLER, "").length;
        if (target <= at + len) {
          let seen = 0;
          let j = 0;
          for (; j < data.length && seen < target - at; j++) if (data[j] !== FILLER) seen++;
          // Past the filler, so a caret after a chip sits after it, not before it.
          while (j < data.length && data[j] === FILLER && seen === target - at && j === 0) j++;
          return [child, j];
        }
        at += len;
      } else if (child instanceof HTMLElement && child.dataset.raw !== undefined) {
        const len = child.dataset.raw.length;
        if (target === at) return [root, i];
        if (target < at + len) return [root, i + 1];
        at += len;
      } else if (child instanceof HTMLElement && child.dataset.end !== undefined) {
        return [root, i];
      }
    }
    return [root, kids.length];
  };

  const select = (start: number, end: number) => {
    const root = box.current;
    const sel = window.getSelection();
    if (!root || !sel) return;
    const range = document.createRange();
    range.setStart(...pointOf(start));
    range.setEnd(...pointOf(end));
    sel.removeAllRanges();
    sel.addRange(range);
  };

  /** Draw `text` into the box: text runs as text, references and quotes as chips. */
  const draw = (pieces: DraftPiece[]) => {
    const root = box.current;
    if (!root) return;
    const fragment = document.createDocumentFragment();
    pieces.forEach((piece, i) => {
      if (piece.kind === "text") {
        fragment.appendChild(document.createTextNode(piece.raw));
        return;
      }
      // A caret can rest beside a chip only in text: a filler where there is none.
      if (pieces[i - 1]?.kind !== "text") fragment.appendChild(document.createTextNode(FILLER));
      fragment.appendChild(chipNode(piece, pieces.slice(0, i)));
      if (pieces[i + 1]?.kind !== "text") fragment.appendChild(document.createTextNode(FILLER));
    });
    // A last line break shows (and holds the caret) only with something after it.
    const end = document.createElement("br");
    end.dataset.end = "";
    fragment.appendChild(end);
    root.replaceChildren(fragment);
  };

  // A value that differs from what is drawn (set by the composer, or a chip that now forms) is drawn again, and the caret put back.
  useLayoutEffect(() => {
    const root = box.current;
    // An IME's text is the browser's to draw until it is done; compositionend reads it.
    if (!root || composing.current) return;
    const focused = document.activeElement === root;
    const [start, end] = focused ? selection() : [value.length, value.length];
    if (value !== known.current) {
      // The composer set the draft (recall, completion, stash, a list's Enter): undoable, except a cleared box after a send starts afresh.
      const kept = value === "" ? [] : shiftRangesDiff(pasteRanges.current, known.current, value);
      if (value === "") history.current.reset();
      else history.current.record({ value: known.current, selection: [Math.min(start, known.current.length), Math.min(end, known.current.length)], pastes: pasteRanges.current }, value, Date.now(), "edit");
      pasteRanges.current = kept;
      known.current = value;
    }
    const pieces = draftPieces(value, typed.current === value && start === end ? start : undefined, pasteRanges.current);
    const shown = readText(root);
    if (shown.text === value && shown.flat && drawnChips(root) === chipsOf(pieces)) {
      if (pending.current) {
        select(...pending.current);
        pending.current = null;
      }
      return;
    }
    draw(pieces);
    const at = pending.current ?? [Math.min(start, value.length), Math.min(end, value.length)];
    pending.current = null;
    if (focused) select(at[0], at[1]);
  }, [value, shape]);

  // The textarea's handle; tests read the same `value` off the element.
  useImperativeHandle(ref, () => ({
    get value() {
      return current.current;
    },
    get selectionStart() {
      return selection()[0];
    },
    get selectionEnd() {
      return selection()[1];
    },
    setSelectionRange: (start: number, end: number) => select(start, end),
    focus: () => box.current?.focus(),
    get offsetHeight() {
      return box.current?.offsetHeight ?? 0;
    },
  }));
  useLayoutEffect(() => {
    const root = box.current;
    if (root) Object.defineProperty(root, "value", { configurable: true, get: () => current.current });
  }, []);

  /** Say the draft is now `next` with its pastes at `pastes`, keeping what it was (with its caret `before`) for undo. */
  const change = (next: string, before: [number, number], pastes: PasteRange[], kind?: "edit") => {
    history.current.record({ value: current.current, selection: before, pastes: pasteRanges.current }, next, Date.now(), kind);
    pasteRanges.current = pastes;
    known.current = next;
    onChange(next);
  };

  /** Put `text` where the selection is, as typing would, and say so; a long paste becomes a chip. */
  const insert = (text: string, pasted = false) => {
    const [start, end] = selection();
    const next = current.current.slice(0, start) + text + current.current.slice(end);
    pending.current = [start + text.length, start + text.length];
    typed.current = next;
    let pastes = shiftRanges(pasteRanges.current, start, end, text.length);
    if (pasted && isLongPaste(text)) pastes = addRange(pastes, { id: nextPasteId.current++, start, length: text.length });
    change(next, [start, end], pastes, "edit");
  };

  /** A paste chip back to plain text, the caret after it. It does not come back as a chip. */
  const expand = (id: number) => {
    const range = pasteRanges.current.find((r) => r.id === id);
    if (!range) return;
    pasteRanges.current = pasteRanges.current.filter((r) => r.id !== id);
    pending.current = [range.start + range.length, range.start + range.length];
    typed.current = null;
    box.current?.focus();
    setShape((n) => n + 1);
  };

  /** Go back (or forward) one step of the box's own history. */
  const travel = (back: boolean) => {
    const now: DraftSnap = { value: current.current, selection: selection(), pastes: pasteRanges.current };
    const snap = back ? history.current.undo(now) : history.current.redo(now);
    if (!snap) return;
    pending.current = snap.selection;
    typed.current = null;
    pasteRanges.current = usableRanges(snap.value, snap.pastes ?? []);
    known.current = snap.value;
    onChange(snap.value);
  };
  const travelRef = useRef(travel);
  travelRef.current = travel;
  // The browser's own undo (its menu, the OS's shortcut) would act on a box it no longer remembers: take it here.
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const on = (e: Event) => {
      const type = (e as InputEvent).inputType;
      if (type !== "historyUndo" && type !== "historyRedo") return;
      e.preventDefault();
      travelRef.current(type === "historyUndo");
    };
    root.addEventListener("beforeinput", on);
    return () => root.removeEventListener("beforeinput", on);
  }, []);

  const onInput = () => {
    const root = box.current;
    if (!root) return;
    const { text } = readText(root);
    typed.current = text;
    if (text !== current.current) {
      // The caret before the change is where the old and new text first differ.
      let p = 0;
      while (p < text.length && p < current.current.length && text[p] === current.current[p]) p++;
      change(text, [p, p], shiftRangesDiff(pasteRanges.current, current.current, text));
    }
  };

  /** The draft without a chip's text: a paste's range goes with it, the other ranges move. */
  const withoutChip = (piece: DraftPiece): { next: string; pastes: PasteRange[] } => {
    const next = withoutPiece(current.current, piece);
    return { next, pastes: piece.kind === "paste" ? shiftRanges(pasteRanges.current, piece.start, piece.start + piece.raw.length, 0) : shiftRangesDiff(pasteRanges.current, current.current, next) };
  };

  const removeChip = (chip: HTMLElement) => {
    const root = box.current;
    if (!root) return;
    const raw = chip.dataset.raw ?? "";
    const start = offsetOf(root, Array.from(root.childNodes).indexOf(chip));
    const piece = draftPieces(current.current, undefined, pasteRanges.current).find((p) => p.start === start && p.raw === raw);
    if (!piece) return;
    const { next, pastes } = withoutChip(piece);
    pending.current = [start, start];
    typed.current = null;
    box.current?.focus();
    change(next, [start + raw.length, start + raw.length], pastes, "edit");
  };

  return (
    <div
      ref={box}
      className={`${className ?? ""}${value === "" ? " is-empty" : ""}`}
      style={style}
      role="textbox"
      aria-multiline="true"
      aria-label={props["aria-label"]}
      aria-autocomplete={props["aria-autocomplete"]}
      aria-controls={props["aria-controls"]}
      aria-activedescendant={props["aria-activedescendant"]}
      aria-placeholder={placeholder}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      contentEditable={!disabled}
      suppressContentEditableWarning
      tabIndex={disabled ? -1 : 0}
      enterKeyHint={enterKeyHint}
      spellCheck
      onInput={onInput}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => {
        composing.current = false;
        onInput();
      }}
      onKeyDown={(e) => {
        // A key on a chip's own label (a tab stop inside the box) is not the composer's: it only puts a paste back as text.
        if (e.target !== e.currentTarget) {
          const chip = (e.target as HTMLElement).closest<HTMLElement>(".draft-chip.is-paste");
          if (chip && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            expand(Number(chip.dataset.paste));
          }
          return;
        }
        onKeyDown?.(e);
        if (e.defaultPrevented || e.nativeEvent.isComposing) return;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === "z" || (e.key.toLowerCase() === "y" && e.ctrlKey && !e.shiftKey))) {
          e.preventDefault();
          travel(e.key.toLowerCase() === "z" && !e.shiftKey);
          return;
        }
        if (e.key === "Enter") {
          // A line break as text, never the browser's <div>; a chord the composer left alone does nothing.
          e.preventDefault();
          if (!e.ctrlKey && !e.metaKey && !e.altKey) insert("\n");
          return;
        }
        if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // A chip goes whole, as one character would.
          const [start, end] = selection();
          if (start !== end) return;
          const piece = draftPieces(current.current, undefined, pasteRanges.current).find((p) => p.kind !== "text" && (e.key === "Backspace" ? p.start + p.raw.length === start : p.start === start));
          if (!piece) return;
          e.preventDefault();
          pending.current = [piece.start, piece.start];
          typed.current = null;
          const { next, pastes } = withoutChip(piece);
          change(next, [start, start], pastes, "edit");
        }
      }}
      onPaste={(e) => {
        onPaste?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        insert(e.clipboardData.getData("text/plain"), true);
      }}
      onDrop={(e) => {
        // Files go to the composer's own drop; dragged text arrives as plain text.
        if (e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        insert(e.dataTransfer.getData("text/plain"));
      }}
      onMouseDown={(e) => {
        // The × and a paste chip keep the caret in the box.
        if ((e.target as HTMLElement).closest(".draft-chip-x, .draft-chip.is-paste")) e.preventDefault();
      }}
      onClick={(e) => {
        const x = (e.target as HTMLElement).closest(".draft-chip-x");
        const chip = x?.closest<HTMLElement>(".draft-chip");
        if (chip) {
          removeChip(chip);
          return;
        }
        const paste = (e.target as HTMLElement).closest<HTMLElement>(".draft-chip.is-paste");
        if (paste) expand(Number(paste.dataset.paste));
      }}
    />
  );
});
