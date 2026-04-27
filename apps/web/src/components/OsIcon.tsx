import { resolveOsIcon } from "@/lib/os-icons";

const DEFAULT_VIEWBOX = "0 0 24 24";

export function OsIcon({ os, className }: { os: string | null | undefined; className?: string }) {
  const icon = resolveOsIcon(os);
  if (!icon) return null;

  return (
    <svg
      viewBox={icon.viewBox ?? DEFAULT_VIEWBOX}
      fill="currentColor"
      className={`overflow-visible ${className ?? ""}`}
      aria-hidden
    >
      <path d={icon.path} />
    </svg>
  );
}
