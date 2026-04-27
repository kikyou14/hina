import {
  Bookmark01Icon,
  Chip02Icon,
  CloudServerIcon,
  CodeIcon,
  ComputerIcon,
  CpuIcon,
  DatabaseIcon,
  Flag01Icon,
  Globe02Icon,
  Home01Icon,
  LinkCircleIcon,
  LockIcon,
  MonitorDotIcon,
  RocketIcon,
  Route01Icon,
  ServerStack01Icon,
  Shield01Icon,
  StarIcon,
  Tag01Icon,
  Wifi01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

const ICON_MAP: Record<string, IconSvgElement> = {
  tag: Tag01Icon,
  star: StarIcon,
  shield: Shield01Icon,
  globe: Globe02Icon,
  database: DatabaseIcon,
  code: CodeIcon,
  cpu: CpuIcon,
  wifi: Wifi01Icon,
  lock: LockIcon,
  flag: Flag01Icon,
  bookmark: Bookmark01Icon,
  rocket: RocketIcon,
  home: Home01Icon,
  computer: ComputerIcon,
  chip: Chip02Icon,
  link: LinkCircleIcon,
  server: ServerStack01Icon,
  cloud: CloudServerIcon,
  route: Route01Icon,
  monitor: MonitorDotIcon,
};

// Radix UI accent color names → oklch values
const TAG_COLORS: Record<string, string> = {
  tomato: "oklch(0.70 0.16 22)",
  red: "oklch(0.70 0.18 25)",
  ruby: "oklch(0.68 0.18 15)",
  crimson: "oklch(0.68 0.18 5)",
  pink: "oklch(0.72 0.15 340)",
  plum: "oklch(0.68 0.16 320)",
  purple: "oklch(0.70 0.18 300)",
  violet: "oklch(0.70 0.16 285)",
  iris: "oklch(0.68 0.16 275)",
  indigo: "oklch(0.68 0.16 265)",
  blue: "oklch(0.72 0.14 250)",
  sky: "oklch(0.74 0.12 230)",
  cyan: "oklch(0.72 0.12 210)",
  teal: "oklch(0.72 0.12 185)",
  jade: "oklch(0.72 0.13 170)",
  green: "oklch(0.72 0.15 155)",
  grass: "oklch(0.72 0.15 140)",
  mint: "oklch(0.76 0.10 170)",
  lime: "oklch(0.78 0.15 125)",
  yellow: "oklch(0.82 0.15 90)",
  amber: "oklch(0.78 0.15 75)",
  orange: "oklch(0.75 0.15 55)",
  brown: "oklch(0.65 0.08 55)",
  bronze: "oklch(0.68 0.08 60)",
  gold: "oklch(0.78 0.12 85)",
  gray: "oklch(0.65 0.02 250)",
};

const DEFAULT_COLOR = TAG_COLORS["blue"];
const DEFAULT_ICON = Tag01Icon;

const TAG_SUFFIX_RE = /^(.+)<([^>]+)>$/;

export type ParsedTag = { text: string; color: string; icon: IconSvgElement };

export function parseTag(raw: string): ParsedTag {
  const m = raw.match(TAG_SUFFIX_RE);
  if (!m) return { text: raw, color: DEFAULT_COLOR, icon: DEFAULT_ICON };

  const text = m[1];
  const parts = m[2].split(",").map((s) => s.trim());
  const color = TAG_COLORS[parts[0]] ?? DEFAULT_COLOR;
  const icon = ICON_MAP[parts[1]] ?? DEFAULT_ICON;
  return { text, color, icon };
}
