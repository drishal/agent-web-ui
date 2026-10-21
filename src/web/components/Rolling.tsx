// A short number that rolls as it changes ("9s" → "10s"): each digit that
// changes slides up out of its place while the new one slides in from below
// (the old digit is drawn by CSS from data-from, so text never reads it).
// Columns are matched from the right, so units stay put as the number grows.
// What is there on first render does not move (a resumed chat is still).
import { useEffect, useRef } from "react";

const DIGIT = /\d/;

export function Rolling({ text }: { text: string }) {
  const shown = useRef(text);
  const from = useRef(new Map<number, { from: string; to: string }>());
  const last = shown.current;
  if (last !== text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[text.length - 1 - i] as string;
      const old = last[last.length - 1 - i] ?? "";
      if (c !== old && DIGIT.test(c)) from.current.set(i, { from: DIGIT.test(old) ? old : "", to: c });
    }
  }
  useEffect(() => {
    shown.current = text;
  }, [text]);
  const chars = [...text].map((c, at) => {
    const i = text.length - 1 - at;
    const roll = from.current.get(i);
    return roll && roll.to === c ? (
      <span key={`${i}:${c}:${roll.from}`} className="roll-col" data-from={roll.from || undefined}>
        <span className="roll-in">{c}</span>
      </span>
    ) : (
      <span key={`${i}:${c}`}>{c}</span>
    );
  });
  return <span className="roll">{chars}</span>;
}
