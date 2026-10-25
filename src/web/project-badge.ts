// A project's folder carries a monogram instead of a generic folder icon: its
// first letter, in a hue taken from the name. Derived, so it looks the same on
// every device and needs nothing stored; a custom icon could sit on top later.
export interface ProjectMonogram {
  letter: string;
  hue: number;
}

export function projectMonogram(name: string): ProjectMonogram {
  const trimmed = name.trim();
  const letter = (trimmed.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  let hash = 0;
  for (const ch of trimmed) hash = (Math.imul(hash, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return { letter, hue: hash % 360 };
}
