// A status word that swaps in place (the chat header's Idle / Working): when it changes it fades in from a 2px blur,
// never from below 0.4 opacity so it stays readable. The first paint does not animate (a chat just opened is no news).
// The look is .word-in in motion.css; reduced motion turns it off there. Never put this on text with background-clip: text.
import { useLayoutEffect, useRef, useState } from "react";

export function StatusWord({ text }: { text: string }) {
  const last = useRef(text);
  const [swaps, setSwaps] = useState(0);
  // Layout effect, so the remounted span with the new word is in the same frame the old one would have shown.
  useLayoutEffect(() => {
    if (last.current === text) return;
    last.current = text;
    setSwaps((n) => n + 1);
  }, [text]);
  return (
    <span key={swaps} className={swaps > 0 ? "word-in" : undefined}>
      {text}
    </span>
  );
}
