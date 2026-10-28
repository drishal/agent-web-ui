// The clock of a "hold to confirm" press: `down` starts, `tick` advances and
// returns the fill 0..1 (firing `onFire` once past `holdMs`), `up` and
// `cancel` reset. Pure: the caller passes `now` (a rAF timestamp or a test's
// fake clock). HoldButton.tsx is only the pointer wiring and the ring.

export type Hold = {
  /** True while a press is underway. */
  readonly holding: boolean;
  down: (now: number) => void;
  up: () => void;
  cancel: () => void;
  /** Advance the clock; returns the fill so the ring redraws each frame. */
  tick: (now: number) => number;
};

export function makeHold(holdMs: number, onFire: () => void): Hold {
  let started: number | null = null;
  let fired = false;
  let progress = 0;
  return {
    get holding() {
      return started !== null;
    },
    down(now) {
      if (started !== null) return;
      started = now;
      fired = false;
      progress = 0;
    },
    up() {
      // Letting go early cancels; a press that already fired just ends.
      started = null;
      progress = 0;
    },
    cancel() {
      started = null;
      fired = false;
      progress = 0;
    },
    tick(now) {
      if (started === null) return 0;
      progress = Math.min(1, Math.max(0, (now - started) / holdMs));
      if (!fired && now - started >= holdMs) {
        fired = true;
        onFire();
      }
      return progress;
    },
  };
}
