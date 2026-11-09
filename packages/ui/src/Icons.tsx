// Icons drawn here, in the outlined style of docs/DESIGN.md: 24×24, 1.75 stroke,
// currentColor. Nothing is loaded from a third party (packages/ui/AGENTS.md).
import { createContext, useContext, type ReactNode } from "react";

function Svg(props: { children: ReactNode; size?: number; title?: string }) {
  const size = props.size ?? 18;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={props.title ? "img" : undefined}
      aria-hidden={props.title ? undefined : true}
      aria-label={props.title}
    >
      {props.children}
    </svg>
  );
}

interface IconProps {
  size?: number;
}

// --- Interface ---

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const AttachIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  </Svg>
);
export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9" />
  </Svg>
);
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 3.5V17H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
  </Svg>
);
export const TuneIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Svg>
);
export const LogoutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h9" />
  </Svg>
);
export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
/** Delegation: one agent handing work to others. */
export const HubIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.5" />
    <circle cx="5" cy="6" r="1.75" />
    <circle cx="19" cy="6" r="1.75" />
    <circle cx="12" cy="20" r="1.75" />
    <path d="M6.4 7.2l3.7 3.1M17.6 7.2l-3.7 3.1M12 14.5v3.75" />
  </Svg>
);
export const TerminalIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
    <path d="M7 9.5l3 2.5-3 2.5M12.5 15H17" />
  </Svg>
);
export const ModelIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Svg>
);
/** Remember now: a note being kept. */
export const RememberIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1z" />
    <path d="M12 7.5v5M9.5 10h5" />
  </Svg>
);
/** Compact: lines pressed together. */
export const CompactIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h16M4 18h16M9 10l3 2.5L15 10M9 14l3-2.5 3 2.5" />
  </Svg>
);
export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  </Svg>
);
export const ToolIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" />
  </Svg>
);

/** Plan: a flag on a milestone. */
export const FlagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Svg>
);
export const InboxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 13l2.5-8h11L20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    <path d="M4 13h4.5l1 2.5h5l1-2.5H20" />
  </Svg>
);

// --- Agents: a pack of animals, one per agent name ---

/** The tortoise is Jabuti's own mark. */
export const TortoiseIcon = (p: IconProps & { title?: string }) => (
  <Svg {...p}>
    <path d="M4 15.5c0-4.4 3.6-8 8-8s8 3.6 8 8z" />
    <path d="M8 15.5l1.5-4h5l1.5 4M12 7.5v4" />
    <path d="M19.4 14c.3-.9 1-1.6 1.9-1.6a1.4 1.4 0 0 1 0 2.8h-1.2" />
    <path d="M6.5 15.5v2.5M17.5 15.5v2.5M3 15.5h18" />
  </Svg>
);

const OwlIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 5l2.5 2M18 5l-2.5 2" />
    <path d="M5.5 10.5a6.5 6.5 0 0 1 13 0V16a5 5 0 0 1-5 5h-3a5 5 0 0 1-5-5z" />
    <circle cx="9.5" cy="11" r="2" />
    <circle cx="14.5" cy="11" r="2" />
    <path d="M11.2 14l.8 1.2.8-1.2" />
  </Svg>
);
const FoxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l3.5 6M20 4l-3.5 6" />
    <path d="M4 4l1.5 8L12 20l6.5-8L20 4l-5 4.5H9z" />
    <circle cx="9.3" cy="12" r="0.4" />
    <circle cx="14.7" cy="12" r="0.4" />
    <path d="M11 16.5h2" />
  </Svg>
);
const RabbitIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 10.5C8 7.5 8 3.5 9.5 3s2 4 2 7.5M14.5 10.5c1.5-3 1.5-7 0-7.5s-2 4-2 7.5" />
    <circle cx="12" cy="15.5" r="5.5" />
    <circle cx="10" cy="14.5" r="0.4" />
    <circle cx="14" cy="14.5" r="0.4" />
    <path d="M11.2 17.2l.8.6.8-.6" />
  </Svg>
);
const CatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4.5l3 4M19 4.5l-3 4" />
    <path d="M5 4.5V13a7 7 0 0 0 14 0V4.5l-3 4a8 8 0 0 0-8 0z" />
    <circle cx="9.5" cy="12.5" r="0.4" />
    <circle cx="14.5" cy="12.5" r="0.4" />
    <path d="M11 15l1 .8 1-.8M3 14.5l4 .5M3 17l4-.5M21 14.5l-4 .5M21 17l-4-.5" />
  </Svg>
);
const BearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="6.5" r="2.5" />
    <circle cx="17.5" cy="6.5" r="2.5" />
    <circle cx="12" cy="13" r="7.5" />
    <ellipse cx="12" cy="15.5" rx="3" ry="2.3" />
    <circle cx="9" cy="11" r="0.4" />
    <circle cx="15" cy="11" r="0.4" />
    <path d="M11.3 14.8h1.4" />
  </Svg>
);
const FishIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12c3-4.5 9-6 13-2.5L21 6v12l-5-3.5C12 18 6 16.5 3 12z" />
    <circle cx="8" cy="11" r="0.5" />
    <path d="M11.5 9.5c.8 1.6.8 3.4 0 5" />
  </Svg>
);
const BirdIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 6.5a3 3 0 0 0-5.5 1.7V11L3 18h9a7 7 0 0 0 7-7V8.5L21 8l-2.5-1.5" />
    <circle cx="15.5" cy="7.5" r="0.4" />
    <path d="M10 18l-1.5 3M13 18l1 3" />
  </Svg>
);
const BeeIcon = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="14" rx="4.5" ry="6" />
    <path d="M7.6 12.5h8.8M7.6 16h8.8M12 8v-1.5" />
    <path d="M10.5 6.5C9 4 6 4 5.5 6s1.5 3.5 3.5 2.5M13.5 6.5C15 4 18 4 18.5 6s-1.5 3.5-3.5 2.5" />
  </Svg>
);
const FrogIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="7.5" r="2.5" />
    <circle cx="16" cy="7.5" r="2.5" />
    <path d="M5.5 9C3.5 11 3 13.5 4 16c1.5 3 4.5 4 8 4s6.5-1 8-4c1-2.5.5-5-1.5-7" />
    <path d="M8.5 15c2.2 1.4 4.8 1.4 7 0" />
    <circle cx="8" cy="7.5" r="0.4" />
    <circle cx="16" cy="7.5" r="0.4" />
  </Svg>
);

const ANIMALS = [
  OwlIcon,
  FoxIcon,
  RabbitIcon,
  CatIcon,
  BearIcon,
  FishIcon,
  BirdIcon,
  BeeIcon,
  FrogIcon,
];

/**
 * Each agent's animal: its name's hash picks a slot, and a taken slot moves on to
 * the next free one, in name order. So agents differ while there are animals left,
 * and a new agent moves only the one it collides with.
 */
export function animals(names: string[]): Map<string, number> {
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const name of [...names].sort()) {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    let slot = hash % ANIMALS.length;
    for (let i = 0; i < ANIMALS.length && taken.has(slot); i++) slot = (slot + 1) % ANIMALS.length;
    taken.add(slot);
    out.set(name, slot);
  }
  return out;
}

/** The agents' animals, set once by the app from the agent list. */
export const AnimalsContext = createContext<Map<string, number>>(new Map());

export function AgentIcon(props: { agent: string; size?: number }) {
  const slots = useContext(AnimalsContext);
  const slot = slots.get(props.agent) ?? animals([props.agent]).get(props.agent) ?? 0;
  const Animal = ANIMALS[slot] ?? OwlIcon;
  return <Animal size={props.size} />;
}
