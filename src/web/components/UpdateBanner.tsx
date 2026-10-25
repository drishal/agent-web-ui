// A deploy landed while this page stayed open: the server serves a build other
// than the one this page loaded. Nothing reloads by itself — a run may be going
// and a draft may be half typed — so the answer is a strip with one button, in
// place of the browser reload an installed app does not have.
import { reloadApp, useNewBuild } from "../app-update.js";

export function UpdateBanner() {
  if (!useNewBuild()) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new build is available.</span>
      <button type="button" className="btn btn-primary btn-small" onClick={() => void reloadApp()}>
        Reload
      </button>
    </div>
  );
}
