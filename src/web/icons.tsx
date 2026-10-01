// Small inline stroke icons (no icon font, no CDN). 16px grid, currentColor.
import type { ToolCategory } from "../shared/protocol.js";

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3M6 8h4M6 10.5h4" />
  </Svg>
);
export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 2.5l3 3-7.75 7.75H2.75v-3z" />
    <path d="M9 4l3 3" />
  </Svg>
);
export const IconFilePlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M8 7v4.5M5.75 9.25h4.5" />
  </Svg>
);
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M4.5 6.25l2 1.75-2 1.75M8 10.25h3.25" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25l3.5 3.5" />
  </Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c1.75 1.9 2.5 3.9 2.5 6.25S9.75 12.35 8 14.25C6.25 12.35 5.5 10.35 5.5 8S6.25 3.65 8 1.75z" />
  </Svg>
);
export const IconTool = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.75 2.25a3.25 3.25 0 00-3.4 4.4L2.25 10.75v3h3l4.1-4.1a3.25 3.25 0 004.4-3.4l-2 2-2-.5-.5-2z" />
  </Svg>
);
export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3M3.6 3.6l2 2M10.4 10.4l2 2M12.4 3.6l-2 2M5.6 10.4l-2 2" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3M3.75 7.25L8 3l4.25 4.25" />
  </Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75" />
    <path d="M10.75 5.25V3.75a1.5 1.5 0 00-1.5-1.5h-5a1.5 1.5 0 00-1.5 1.5v5a1.5 1.5 0 001.5 1.5h1.5" />
  </Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="0.9" fill="currentColor" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.9" fill="currentColor" />
  </Svg>
);
export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2l6.25 11H1.75z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4M8 4.75v.01" />
  </Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 4.25a1.5 1.5 0 011.5-1.5h3l1.5 1.75h5a1.5 1.5 0 011.5 1.5v6.25a1.5 1.5 0 01-1.5 1.5h-9.5a1.5 1.5 0 01-1.5-1.5z" />
  </Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconQueue = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h5" />
  </Svg>
);
export const IconSteer = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13c0-5 3-7.5 8.5-7.5" />
    <path d="M9 3l2.75 2.5L9 8" />
  </Svg>
);
export const IconCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="4.75" strokeDasharray="2 2.2" />
  </Svg>
);
export const IconDot = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
  </Svg>
);

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
      <path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function ToolIcon({ category, size }: { category: ToolCategory; size?: number }) {
  const props = size ? { size } : {};
  switch (category) {
    case "read":
      return <IconFile {...props} />;
    case "edit":
      return <IconEdit {...props} />;
    case "write":
      return <IconFilePlus {...props} />;
    case "command":
      return <IconTerminal {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "web":
      return <IconGlobe {...props} />;
    default:
      return <IconTool {...props} />;
  }
}
