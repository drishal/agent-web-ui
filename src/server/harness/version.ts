// A harness's version as the UI shows it: short and comparable on the menu
// row (1.0.2, 18.6.1, 2026.9.24), with the CLI's own line kept for the tooltip.

export interface VersionLabel {
  version: string;
  /** The CLI's full version line, when it says more than `version`. */
  versionDetail?: string;
}

const PLACEHOLDER = /^0+(?:\.0+)*$/;

/**
 * `raw` is the CLI's version output, its program name already removed. The
 * short form is the line's first version number without a leading "v"; when
 * that is a placeholder (0.0.0, as Nix builds of Hermes report), a release
 * date in the line (2026.9.24) stands in: it tells how old a build is at a
 * glance, which a commit hash does not. Unparseable output is shown as is.
 */
export function versionLabel(raw: string): VersionLabel {
  const line = raw.trim().split("\n")[0]?.trim() ?? "";
  const number = /(?:^|[\s(/])v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)(?=$|[\s)·,])/.exec(line)?.[1];
  const date = /(?:^|[\s(])(20\d{2}[.-]\d{1,2}[.-]\d{1,2})(?=$|[\s)·,])/.exec(line)?.[1];
  const version = number && PLACEHOLDER.test(number) && date ? date : (number ?? line);
  return version && version !== line ? { version, versionDetail: line } : { version: line };
}
