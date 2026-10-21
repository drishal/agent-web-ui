// The separator dot between facts on one line ("bash · npm test · 2s"). It is
// drawn by CSS (.dot), the same small round dot everywhere; its text stays
// " · ", so accessible names, copied text, and textContent still read it.
import { Fragment, type ReactNode } from "react";

export function Dot() {
  return <span className="dot"> · </span>;
}

/** Facts joined by the separator dot; empty ones left out. */
export function dotted(parts: ReactNode[]): ReactNode {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== false && p !== "")
    .map((p, i) => (
      <Fragment key={i}>
        {i > 0 ? <Dot /> : null}
        {p}
      </Fragment>
    ));
}
