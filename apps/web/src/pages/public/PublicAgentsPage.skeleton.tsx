import { Skeleton } from "@/components/ui/skeleton";

function ResourceBarSkeleton() {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-8" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
    </div>
  );
}

function AgentCardSkeleton() {
  return (
    <div className="bg-card flex flex-col rounded-lg border p-4">
      {/* Name row */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="size-5 rounded" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="size-2 rounded-full" />
        </div>
        <Skeleton className="h-3 w-14" />
      </div>
      {/* 4 resource bars */}
      <div className="space-y-2.5">
        {Array.from({ length: 4 }, (_, i) => (
          <ResourceBarSkeleton key={i} />
        ))}
      </div>
      {/* Footer stats */}
      <div className="mt-3 flex items-center gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

function AgentListRowSkeleton() {
  return (
    <div className="border-b px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className="h-3.5 w-28" />
        </div>
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="mt-2 grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-1 w-full rounded-full" />
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

export function AgentListPageSkeleton({ view }: { view: "cards" | "list" }) {
  if (view === "list") {
    return (
      <div className="rounded-lg border">
        {Array.from({ length: 8 }, (_, i) => (
          <AgentListRowSkeleton key={i} />
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <AgentCardSkeleton key={i} />
      ))}
    </div>
  );
}
