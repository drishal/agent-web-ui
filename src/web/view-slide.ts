// Which way the sidebar's session list slides when its view changes: leaving a
// folder for all projects goes back (the new list comes from the left), and
// everything else — into a folder, or from one folder to another — goes forward
// (from the right). Keys are "all" or a workspace id.
export type ViewSlideDirection = "forward" | "back";

export const VIEW_SLIDE_MS = 190;
/** How far a forward slide starts from, in px; a backward one starts negative. */
export const VIEW_SLIDE_OFFSET = 22;

export function viewSlideDirection(previous: string, next: string): ViewSlideDirection {
  return previous !== "all" && next === "all" ? "back" : "forward";
}
