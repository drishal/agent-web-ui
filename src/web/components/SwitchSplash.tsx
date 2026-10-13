// The screen a chat opens under. The moment a session is picked it shows that
// session's title, harness, and project over a ghost of a thread, so the click
// answers at once; when the chat has drawn underneath, it fades away.
import { harnessColor } from "../harness-colors.js";

export interface SplashTarget {
  title: string;
  harnessId: string;
  harnessName: string;
  /** The project's name, where the harness has projects. */
  project: string | null;
}

export function SwitchSplash({ target, leaving }: { target: SplashTarget; leaving: boolean }) {
  return (
    <div className={`switch-splash${leaving ? " is-leaving" : ""}`} style={harnessColor(target.harnessId)} role="status" aria-label={`Opening ${target.title}`}>
      <div className="splash-head">
        <svg className="splash-mark" width="56" height="28" viewBox="0 0 56 28" aria-hidden="true">
          <path className="loader-track" d="M28 14c-6-8-18-8-18 0s12 8 18 0 18-8 18 0-12 8-18 0z" />
          <path className="loader-run" d="M28 14c-6-8-18-8-18 0s12 8 18 0 18-8 18 0-12 8-18 0z" pathLength="100" />
        </svg>
        <h2 className="splash-title">{target.title}</h2>
        <p className="splash-sub">
          <span className="badge badge-harness">{target.harnessName}</span>
          {target.project ? <span className="splash-project">{target.project}</span> : null}
        </p>
      </div>
      <div className="splash-ghost" aria-hidden="true">
        <span className="ghost-bubble" />
        <span className="ghost-line" />
        <span className="ghost-line" />
        <span className="ghost-line" />
        <span className="ghost-line" />
        <span className="ghost-bubble is-short" />
        <span className="ghost-line" />
        <span className="ghost-line" />
      </div>
    </div>
  );
}
