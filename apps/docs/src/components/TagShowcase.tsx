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
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";

// ── Data (mirrors apps/web/src/lib/tags.ts) ──────────────────────────

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

// ── Shared styles ────────────────────────────────────────────────────

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  gap: "6px 12px",
};

const cellStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "5px 0",
};

const codeStyle: React.CSSProperties = {
  fontSize: "13px",
  fontFamily: "var(--sl-font-mono, monospace)",
};

// ── Tag badge (replicates apps/web TagBadge) ─────────────────────────

function TagBadge({ text, color, icon }: { text: string; color: string; icon: IconSvgElement }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        borderRadius: "999px",
        padding: "2px 10px",
        fontSize: "12px",
        fontWeight: 500,
        lineHeight: "20px",
        whiteSpace: "nowrap",
        backgroundColor: `color-mix(in oklch, ${color} 20%, transparent)`,
        color,
      }}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} size={12} />
      {text}
    </span>
  );
}

// ── Exports ──────────────────────────────────────────────────────────

export function ColorPalette() {
  return (
    <div style={gridStyle}>
      {Object.entries(TAG_COLORS).map(([name, value]) => (
        <div key={name} style={cellStyle}>
          <span
            style={{
              display: "inline-block",
              flexShrink: 0,
              width: "22px",
              height: "22px",
              borderRadius: "6px",
              backgroundColor: `color-mix(in oklch, ${value} 25%, transparent)`,
              border: `1.5px solid ${value}`,
            }}
          />
          <code style={codeStyle}>{name}</code>
        </div>
      ))}
    </div>
  );
}

export function IconGallery() {
  return (
    <div style={gridStyle}>
      {Object.entries(ICON_MAP).map(([name, icon]) => (
        <div key={name} style={cellStyle}>
          <HugeiconsIcon icon={icon} strokeWidth={1.5} size={20} />
          <code style={codeStyle}>{name}</code>
        </div>
      ))}
    </div>
  );
}

export function TagExamples({ tags }: { tags: string[] }) {
  const parsed = tags.map((raw) => {
    const m = raw.match(/^(.+)<([^>]+)>$/);
    if (!m) return { text: raw, color: TAG_COLORS["blue"], icon: Tag01Icon };
    const text = m[1];
    const parts = m[2].split(",").map((s) => s.trim());
    return {
      text,
      color: TAG_COLORS[parts[0]] ?? TAG_COLORS["blue"],
      icon: ICON_MAP[parts[1]] ?? Tag01Icon,
    };
  });

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
      {parsed.map((t, i) => (
        <TagBadge key={i} {...t} />
      ))}
    </div>
  );
}
