import { Skeleton } from "@/components/ui/skeleton";

// Full-page skeleton shown while lazy routes or auth guards load.
export function PageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-40" />
      <div className="border-border space-y-4 rounded-lg border p-6">
        <Skeleton className="h-5 w-32" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
      <div className="border-border space-y-4 rounded-lg border p-6">
        <Skeleton className="h-5 w-48" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}
