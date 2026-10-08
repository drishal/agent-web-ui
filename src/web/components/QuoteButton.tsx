// Select text in an answer and a Quote button appears above it (T3 Code's
// quotes): it puts the passage into the draft as a Markdown quote.
import { useEffect, useState } from "react";
import { addToDraft, asQuote } from "../draft-bus.js";

const QUOTABLE = ".answer, .process-text";

export function QuoteButton({ scope }: { scope: React.RefObject<HTMLElement | null> }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    let timer = 0;
    const check = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString() ?? "";
        if (!sel || sel.isCollapsed || !text.trim() || sel.rangeCount === 0) return setAt(null);
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = node instanceof Element ? node : node.parentElement;
        const host = el?.closest(QUOTABLE);
        if (!host || !scope.current?.contains(host)) return setAt(null);
        const rect = range.getBoundingClientRect();
        setAt({ x: rect.left + rect.width / 2, y: rect.top, text });
      }, 120);
    };
    document.addEventListener("selectionchange", check);
    window.addEventListener("scroll", check, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", check);
      window.removeEventListener("scroll", check, true);
    };
  }, [scope]);

  if (!at) return null;
  return (
    <button
      type="button"
      className="quote-btn"
      style={{ left: at.x, top: Math.max(8, at.y - 40) }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        addToDraft(`${asQuote(at.text)}\n\n`);
        window.getSelection()?.removeAllRanges();
        setAt(null);
      }}
      data-testid="quote-btn"
    >
      Quote
    </button>
  );
}
