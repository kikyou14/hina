import { Skeleton } from "@/components/ui/skeleton";

function StatRowSkeleton() {
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-2.5">
      <Skeleton className="mt-0.5 size-7 rounded-md" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3.5 w-24" />
      </div>
    </div>
  );
}

function MetricCardSkeleton() {
  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="border-border flex items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-3.5 w-16" />
        </div>
        <Skeleton className="h-3.5 w-20" />
      </div>
      <div className="p-2 pt-1">
        <Skeleton className="h-[180px] w-full rounded-lg" />
      </div>
    </div>
  );
}

export function AgentDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 xl:flex-row">
      {/* Sidebar */}
      <aside className="w-full shrink-0 xl:w-85">
        <div className="border-border bg-card overflow-hidden rounded-xl border">
          <div className="space-y-0.5 p-2">
            {Array.from({ length: 4 }, (_, i) => (
              <StatRowSkeleton key={i} />
            ))}
            <div className="border-border mx-3 my-1 border-t border-dashed" />
            {Array.from({ length: 4 }, (_, i) => (
              <StatRowSkeleton key={`b${i}`} />
            ))}
            <div className="border-border mx-3 my-1 border-t border-dashed" />
            {Array.from({ length: 4 }, (_, i) => (
              <StatRowSkeleton key={`c${i}`} />
            ))}
          </div>
        </div>
      </aside>

      {/* Main content — 2x3 metric grid + latency card */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <MetricCardSkeleton key={i} />
          ))}
        </div>
        {/* Latency card placeholder */}
        <div className="border-border bg-card overflow-hidden rounded-xl border">
          <div className="px-5 py-4">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="p-4 pt-0">
            <Skeleton className="h-[200px] w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
