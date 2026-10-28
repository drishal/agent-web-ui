// A destructive action behind a ~600ms press (HoldButton): hold and the
// button fills from the left in the danger colour; let go early and it
// resets. The clock lives in hold.ts. Holding Enter or Space works the same
// (repeats ignored); the fill animates through a custom property so the state
// machine has one place that reads it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { makeHold, type Hold } from "../hold.js";

export const HOLD_MS = 600;

export function HoldButton({
  label,
  holdLabel = "Hold to confirm",
  doneLabel,
  onFire,
  disabled,
  className = "",
  children,
}: {
  /** The action, for the aria-label and the title. */
  label: string;
  /** Shown under the label so the hold isn't a surprise. */
  holdLabel?: string;
  /** A live region announces this once fired (e.g. "Undone"). */
  doneLabel: string;
  onFire: () => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [fill, setFill] = useState(0);
  const [done, setDone] = useState(false);
  // The clock is made once, so it calls the latest onFire through a ref: the
  // first render's would act on that render's props (RestoreDialog's file list
  // before its preview loaded).
  const fire = useRef(onFire);
  fire.current = onFire;
  const made = useRef<Hold | null>(null);
  made.current ??= makeHold(HOLD_MS, () => {
    setDone(true);
    fire.current();
  });
  const hold = made.current;
  const raf = useRef(0);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  };
  const start = () => {
    const step = (t: number) => {
      setFill(hold.tick(t));
      if (hold.holding) raf.current = requestAnimationFrame(step);
      else raf.current = 0;
    };
    raf.current = requestAnimationFrame(step);
  };

  useEffect(() => stop, []);

  const down = (t: number) => {
    if (disabled || done) return;
    hold.down(t);
    start();
  };
  const up = () => {
    if (!hold.holding) return;
    hold.up();
    setFill(0);
    stop();
  };

  // A press that slides off the button still has to end: pointerup anywhere.
  useEffect(() => {
    const end = () => up();
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <button
        type="button"
        className={`hold-button ${className}${fill > 0 ? " is-holding" : ""}`}
        style={fill > 0 ? ({ "--hold": fill } as React.CSSProperties) : undefined}
        disabled={disabled || done}
        aria-label={`${label}. ${holdLabel}.`}
        title={`${label} (${holdLabel})`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          down(performance.now());
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            down(performance.now());
          }
        }}
        onKeyUp={(e) => {
          if (e.key === "Enter" || e.key === " ") up();
        }}
        onBlur={() => {
          hold.cancel();
          setFill(0);
          stop();
        }}
      >
        {children}
        <span className="hold-button-label">{label}</span>
        <span className="hold-button-hint" aria-hidden="true">
          {holdLabel}
        </span>
      </button>
      {done ? (
        <span role="status" className="visually-hidden">
          {doneLabel}
        </span>
      ) : null}
    </>
  );
}
