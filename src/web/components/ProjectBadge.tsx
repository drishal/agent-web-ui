// The folder row's monogram (project-badge.ts): one letter, in the project's hue,
// drawn with the theme's accent so a theme switch carries it along.
import { projectMonogram } from "../project-badge.js";

export function ProjectBadge({ name, size = 18 }: { name: string; size?: number }) {
  const { letter, hue } = projectMonogram(name);
  return (
    <span className="project-badge" aria-hidden="true" style={{ width: size, height: size, ["--badge-hue" as string]: `${hue}deg` }}>
      {letter}
    </span>
  );
}
