import { HugeiconsIcon } from "@hugeicons/react";
import { parseTag } from "@/lib/tags";

export function TagBadge({ tag }: { tag: string }) {
  const { text, icon, color } = parseTag(tag);

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 20%, transparent)`,
        color,
      }}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-2.5" />
      {text}
    </span>
  );
}
