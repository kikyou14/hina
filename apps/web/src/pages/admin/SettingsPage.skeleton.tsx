import { Skeleton } from "@/components/ui/skeleton";

function FieldSkeleton() {
  return (
    <div className="grid gap-2">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

export function SiteConfigFormSkeleton() {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <FieldSkeleton />
        <FieldSkeleton />
      </div>
      <FieldSkeleton />
      <div className="grid gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-[150px] w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="grid gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-[100px] w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-9 w-20" />
    </div>
  );
}

export function RuntimeConfigFormSkeleton() {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <FieldSkeleton />
        <FieldSkeleton />
      </div>
      <Skeleton className="h-9 w-20" />
    </div>
  );
}
