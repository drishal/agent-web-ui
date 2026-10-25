// A draft as the pieces it is made of: text, file references, and quoted
// passages. Chips in the composer are a view of these segments, and serializing
// them has to produce exactly the text the composer sends today (@path or
// @path:line, a Markdown block quote), so nothing on the wire changes.
export type DraftSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "quote"; text: string };

/** `@path` or `@path:line`: the form the @ menu, the viewer's Mention, and search use. */
export function fileReference(path: string, line?: number): string {
  return line === undefined ? `@${path}` : `@${path}:${line}`;
}

/** A passage as the Markdown block quote the composer already inserts, one `>` a line. */
export function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * The text a draft is written as: text as typed, references and quotes in their
 * place. A reference that would fuse with the word before it gets one space; a
 * quote starts on its own paragraph and ends with a newline.
 */
export function serializeDraft(segments: readonly DraftSegment[]): string {
  let out = "";
  for (const segment of segments) {
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    if (segment.kind === "file") {
      if (out.length > 0 && !/\s$/.test(out)) out += " ";
      out += fileReference(segment.path, segment.line);
      continue;
    }
    if (out.length > 0 && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
    out += `${quoteBlock(segment.text)}\n`;
  }
  return out;
}
