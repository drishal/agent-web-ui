// A slim bar over the top of the conversation naming the prompt of the turn being read, once that
// prompt has scrolled out of view while its answer has not. Click it to glide back to the prompt.
// It overlays the scroll area (no layout shift), keeps its own state so a scroll never re-renders
// the turns, and measures only on a frame after a scroll, the way TurnRail does. Which turn is
// decided by sticky-prompt.ts.
import { useEffect, useRef, useState } from "react";
import type { Turn } from "../turns.js";
import { stickyLabel, stickyLine, stickyTurn } from "../sticky-prompt.js";

/** `hidden`: something else owns the top of the view (the find bar). `onBeforeGo`: the view is about to leave the end of the chat. */
export function StickyPrompt({ turns, scroller, hidden, onBeforeGo }: { turns: Turn[]; scroller: React.RefObject<HTMLDivElement | null>; hidden: boolean; onBeforeGo: () => void }) {
  const prompted = turns.filter((t) => t.prompt !== null);
  const promptedRef = useRef(prompted);
  promptedRef.current = prompted;
  // An index into the prompted turns: turns only ever append, so it stays right until the next measure.
  const [shown, setShown] = useState(-1);
  const schedule = useRef<() => void>(() => {});

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top;
      const list = promptedRef.current;
      setShown(
        stickyTurn(list.length, (i) => {
          const node = document.getElementById(`turn-${list[i]?.id}`);
          const prompt = node?.querySelector(".turn-prompt");
          if (!node || !prompt) return null;
          return { promptBottom: prompt.getBoundingClientRect().bottom - top, bottom: node.getBoundingClientRect().bottom - top };
        }),
      );
    };
    schedule.current = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    el.addEventListener("scroll", schedule.current, { passive: true });
    return () => {
      el.removeEventListener("scroll", schedule.current);
      schedule.current = () => {};
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [scroller]);
  // A reply growing or a turn arriving moves the edges without a scroll.
  useEffect(() => schedule.current(), [turns]);

  const turn = prompted[shown];
  if (hidden || !turn?.prompt) return null;
  const line = stickyLine(turn.prompt.text);
  return (
    <button
      type="button"
      className="sticky-prompt"
      aria-label={stickyLabel(shown + 1, line)}
      onClick={() => {
        onBeforeGo();
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        document.getElementById(`turn-${turn.id}`)?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
      }}
    >
      <span className="sticky-number" aria-hidden="true">
        #{shown + 1}
      </span>
      <span className="sticky-text" aria-hidden="true">
        {line}
      </span>
    </button>
  );
}
