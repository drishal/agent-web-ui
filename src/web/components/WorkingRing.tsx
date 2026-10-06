// Hermes-style spinning ring for a session whose run is in progress: in the
// sidebar's rows and project heads, and on session tabs.
import { harnessColor } from "../harness-colors.js";

export function WorkingRing({ harnessId, colored }: { harnessId?: string | undefined; colored: boolean }) {
  return <span className={`working-ring${colored ? " is-harness" : ""}`} style={colored ? harnessColor(harnessId) : undefined} role="img" aria-label="Working" title="Working" />;
}
