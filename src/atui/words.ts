// Word-level highlights for an edit's changed lines: a removed line and the
// added line that replaced it are compared token by token, so the exact
// words that changed can be drawn brighter than the rest of the line.

export interface Segment {
  text: string;
  /** This part differs from the other line. */
  changed: boolean;
}

/** Above this many tokens a line is compared whole: the table below is n×m. */
const MAX_TOKENS = 160;

const tokenize = (line: string): string[] => line.match(/\s+|\w+|[^\w\s]/g) ?? [];

/** Joins runs of equal flags so a line is a few segments, not one per token. */
function segments(tokens: string[], changed: boolean[]): Segment[] {
  const out: Segment[] = [];
  tokens.forEach((text, i) => {
    const flag = changed[i] ?? true;
    const last = out[out.length - 1];
    if (last && last.changed === flag) last.text += text;
    else out.push({ text, changed: flag });
  });
  return out;
}

/** The two lines split into what they share and what changed (longest common subsequence of tokens). */
export function wordDiff(before: string, after: string): { before: Segment[]; after: Segment[] } {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return { before: [{ text: before, changed: true }], after: [{ text: after, changed: true }] };
  // lcs[i][j]: the common length of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const keepA = new Array<boolean>(a.length).fill(false);
  const keepB = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) i++;
    else j++;
  }
  // Whitespace alone matching is no anchor: a fully rewritten line stays one changed run.
  const anchored = (tokens: string[], keep: boolean[]) => keep.some((k, n) => k && /\S/.test(tokens[n] as string));
  if (!anchored(a, keepA)) return { before: [{ text: before, changed: true }], after: [{ text: after, changed: true }] };
  return {
    before: segments(
      a,
      keepA.map((k) => !k),
    ),
    after: segments(
      b,
      keepB.map((k) => !k),
    ),
  };
}

export interface PreviewLine {
  marker: "+" | "-" | " ";
  text: string;
}

/**
 * Preview lines with their word highlights: each run of removed lines is
 * paired, line for line, with the added run right after it; unpaired lines
 * are changed throughout.
 */
export function highlightPreview(lines: PreviewLine[]): Array<PreviewLine & { segments: Segment[] }> {
  const out = lines.map((l) => ({ ...l, segments: [{ text: l.text, changed: l.marker !== " " }] }));
  for (let i = 0; i < out.length; ) {
    if (out[i]?.marker !== "-") {
      i++;
      continue;
    }
    let dels = i;
    while (out[dels]?.marker === "-") dels++;
    let adds = dels;
    while (out[adds]?.marker === "+") adds++;
    const pairs = Math.min(dels - i, adds - dels);
    for (let k = 0; k < pairs; k++) {
      const del = out[i + k];
      const add = out[dels + k];
      if (!del || !add) continue;
      const d = wordDiff(del.text, add.text);
      del.segments = d.before;
      add.segments = d.after;
    }
    i = adds;
  }
  return out;
}
