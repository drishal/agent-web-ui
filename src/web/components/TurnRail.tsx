// A thin rail of per-turn marks for long chats (after DeepSeek Harness's turn
// navigator). Desktop only; hidden by CSS on narrow screens and for short chats.
import { useEffect, useState } from "react";
import type { Turn } from "../turns.js";

const MIN_TURNS = 3;

export function TurnRail({ turns, scroller }: { turns: Turn[]; scroller: React.RefObject<HTMLDivElement | null> }) {
  const prompted = turns.filter((t) => t.prompt !== null);
  const [active, setActive] = useState<string | null>(null);
  const ids = prompted.map((t) => t.id).join(",");

  useEffect(() => {
    const list = ids ? ids.split(",") : [];
    const el = scroller.current;
    if (!el || list.length < MIN_TURNS) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top + 80;
      let current: string | null = null;
      for (const id of list) {
        const node = document.getElementById(`turn-${id}`);
        if (node && node.getBoundingClientRect().top <= top) current = id;
      }
      setActive(current ?? list[0] ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [scroller, ids]);

  if (prompted.length < MIN_TURNS) return null;
  return (
    <nav className="turn-rail" aria-label="Jump to turn">
      {prompted.map((turn, i) => {
        const preview = (turn.prompt?.text ?? "").replace(/\s+/g, " ").slice(0, 90);
        return (
          <button
            key={turn.id}
            type="button"
            className={`rail-mark${turn.id === active ? " is-active" : ""}${turn.live ? " is-live" : ""}`}
            aria-label={`Turn ${i + 1}: ${preview}`}
            aria-current={turn.id === active ? "true" : undefined}
            onClick={() => document.getElementById(`turn-${turn.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}
          >
            <span className="rail-tick" aria-hidden="true" />
            <span className="rail-preview" aria-hidden="true">
              {preview}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
