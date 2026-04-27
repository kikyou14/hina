function barColor(pct: number): string {
  if (pct > 80) return "bg-red-500";
  if (pct > 50) return "bg-amber-500";
  return "bg-sky-500";
}

export function ResourceBar({
  label,
  value,
  pct,
}: {
  label: string;
  value: React.ReactNode;
  pct: number | null;
}) {
  const clamped = pct !== null ? Math.max(0, Math.min(100, pct)) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{value}</span>
      </div>
      <div className="bg-foreground/20 h-1.5 w-full overflow-hidden rounded-full">
        {clamped !== null && (
          <div
            className={`h-full rounded-full transition-all ${barColor(clamped)}`}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function MiniBar({
  label,
  pct,
  showLabel = true,
}: {
  label: string;
  pct: number | null;
  showLabel?: boolean;
}) {
  const clamped = pct !== null ? Math.max(0, Math.min(100, pct)) : null;
  const display = clamped !== null ? `${clamped.toFixed(0)}%` : "-";
  return (
    <div className="flex flex-col gap-0.5">
      {showLabel ? (
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium tabular-nums">{display}</span>
        </div>
      ) : (
        <div className="text-[10px] font-medium tabular-nums">{display}</div>
      )}
      <div className="bg-foreground/20 h-1 w-full overflow-hidden rounded-full">
        {clamped !== null && (
          <div
            className={`h-full rounded-full transition-all ${barColor(clamped)}`}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    </div>
  );
}
