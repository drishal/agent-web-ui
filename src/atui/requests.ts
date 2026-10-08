// What a pending request offers as numbered options: Approve and Deny for an
// approval, a question's choices (with their descriptions) otherwise.
import type { InteractionAnswer, InteractionRequest } from "../shared/protocol.js";
import { choicesOf } from "../web/questions.js";

export interface Option {
  label: string;
  detail?: string;
  recommended?: boolean;
  answer: InteractionAnswer;
}

export function isApproval(r: InteractionRequest): boolean {
  if (r.kind === "confirm") return true;
  const opts = (r.options ?? []).map((o) => o.toLowerCase());
  return r.kind === "select" && opts.length === 2 && opts.includes("approve") && opts.includes("deny");
}

export function optionsOf(r: InteractionRequest): Option[] {
  if (isApproval(r)) {
    const yes = r.options?.find((o) => o.toLowerCase() === "approve") ?? "Approve";
    const no = r.options?.find((o) => o.toLowerCase() === "deny") ?? "Deny";
    return r.kind === "confirm"
      ? [
          { label: "Approve", answer: { kind: "confirm", confirmed: true } },
          { label: "Deny", answer: { kind: "confirm", confirmed: false } },
        ]
      : [
          { label: "Approve", answer: { kind: "select", value: yes } },
          { label: "Deny", answer: { kind: "select", value: no } },
        ];
  }
  if (r.kind !== "select") return [];
  return choicesOf(r).map((c) => ({ label: c.label, ...(c.detail ? { detail: c.detail } : {}), recommended: c.recommended, answer: { kind: "select", value: c.value } }));
}
