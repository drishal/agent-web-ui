// A handoff target: a harness that keeps past turns gets a copy of the
// conversation; any other continues from a summary sent as its first prompt.
// The composer's chip and the phone settings sheet both list the same choices.
import type { HarnessStatus } from "../shared/protocol.js";

export function handoffChoice(h: HarnessStatus) {
  if (!h.available) return { harness: h, blocked: h.reason ?? "Not available" };
  return { harness: h, blocked: null, note: h.capabilities.supportsHandoff ? "Copies the conversation" : "Continues from a summary" };
}
