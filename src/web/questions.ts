// A question's options as the harnesses send them: "(Recommended)" and
// "Other (type your own)" in the labels, a "(1/2)" step in the title.
import type { InteractionRequest } from "../shared/protocol.js";

/** A question's "(1/2)" step, split off its text. */
export function splitStep(text: string): { text: string; step: string | null } {
  const m = /\s*\((\d+)\s*\/\s*(\d+)\)\s*$/.exec(text);
  return m ? { text: text.slice(0, m.index).trim(), step: `${m[1]} of ${m[2]}` } : { text, step: null };
}

export interface Choice {
  value: string;
  label: string;
  recommended: boolean;
  /** "Other (type your own)": the harness asks for the text next. */
  other: boolean;
  detail?: string;
}

export function choicesOf(request: InteractionRequest): Choice[] {
  return (request.options ?? []).map((value, i) => {
    const rec = /\s*\(recommended\)\s*$/i.exec(value);
    const label = rec ? value.slice(0, rec.index).trim() : value;
    const detail = request.optionDetails?.[i]?.trim();
    return { value, label, recommended: Boolean(rec), other: /^other\b/i.test(label), ...(detail ? { detail } : {}) };
  });
}
