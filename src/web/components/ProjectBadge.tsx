// The folder row's badge: the project's icon on this device when one is set, else
// its monogram (one letter, in a hue from the name), drawn with the theme accent.
import { projectMonogram } from "../project-badge.js";
import { useProjectIcons } from "../project-icons.js";

export function ProjectBadge({ id, name, size = 18 }: { id?: string; name: string; size?: number }) {
  const icons = useProjectIcons();
  const icon = id === undefined ? undefined : icons[id];
  const { letter, hue } = projectMonogram(name);
  return (
    <span className="project-badge" aria-hidden="true" style={{ width: size, height: size, ["--badge-hue" as string]: `${hue}deg` }}>
      {icon ?? letter}
    </span>
  );
}
