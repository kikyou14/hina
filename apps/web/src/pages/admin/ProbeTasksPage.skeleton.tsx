import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

function ProbeTaskRowSkeletonCompact() {
  return (
    <div className="border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <div className="w-6" />
        <Skeleton className="h-4 w-28" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      </div>
      <div className="mt-1.5 pl-8">
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="mt-1 flex items-center gap-3 pl-8">
        <Skeleton className="h-3 w-8" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

function ProbeTaskRowSkeleton() {
  return (
    <TableRow>
      <TableCell className="w-8 px-1" />
      <TableCell className="w-32">
        <Skeleton className="h-4 w-24" />
      </TableCell>
      <TableCell className="w-24">
        <Skeleton className="h-5 w-12 rounded-full" />
      </TableCell>
      <TableCell className="w-48">
        <Skeleton className="h-3.5 w-36" />
      </TableCell>
      <TableCell className="w-16">
        <Skeleton className="h-3.5 w-8" />
      </TableCell>
      <TableCell className="w-24">
        <Skeleton className="h-3.5 w-16" />
      </TableCell>
      <TableCell className="w-20">
        <Skeleton className="h-5 w-14 rounded-full" />
      </TableCell>
      <TableCell className="w-28">
        <div className="flex gap-2">
          <Skeleton className="h-7 w-14 rounded-md" />
          <Skeleton className="h-7 w-14 rounded-md" />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ProbeTasksPageSkeleton() {
  return (
    <>
      {/* Mobile */}
      <div className="md:hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <ProbeTaskRowSkeletonCompact key={i} />
        ))}
      </div>
      {/* Desktop */}
      <div className="hidden overflow-x-auto md:block">
        <Table className="table-fixed">
          <TableBody>
            {Array.from({ length: 5 }, (_, i) => (
              <ProbeTaskRowSkeleton key={i} />
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
