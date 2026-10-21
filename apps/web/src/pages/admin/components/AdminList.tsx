import { Search } from "lucide-react";
import type * as React from "react";

import { AnimatedTabsList } from "@/components/AnimatedTabsList";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// Admin lists lay out against their own width (the `list` container) rather
// than the viewport: the admin sidebar makes viewport breakpoints a poor proxy
// for the space a list actually gets. From the @2xl container size up, rows are
// table-like grids; below it they stack, with the primary cell, aside and
// actions on the first line and the other cells wrapping onto the next.
//
// Pages pass the wide template as a literal `@2xl/list:grid-cols-[...]` class
// with one track per column, in this order: handle (sortable lists only),
// primary, cells, aside, actions.

// An empty cell collapses in the stacked layout but keeps its track (shown as a
// dash) in the grid, so the columns after it stay aligned.
const CELL =
  "min-w-0 empty:hidden @2xl/list:empty:block @2xl/list:empty:before:text-muted-foreground @2xl/list:empty:before:content-['-']";

export function AdminList({
  grid,
  columns,
  count,
  loading = false,
  empty,
  children,
}: {
  grid: string;
  columns: React.ReactNode[];
  count: number;
  loading?: boolean;
  empty?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (loading) return <AdminListSkeleton />;
  if (count === 0) {
    return empty ? <div className="text-muted-foreground py-10 text-center">{empty}</div> : null;
  }

  return (
    <div className="@container/list">
      <div
        className={cn(
          "text-muted-foreground hidden gap-x-3 border-b pb-2 font-medium @2xl/list:grid",
          grid,
        )}
      >
        {columns.map((column, i) => (
          <div key={i} className="min-w-0 truncate">
            {column}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

export type AdminListRowProps = Omit<React.ComponentProps<"div">, "children"> & {
  grid: string;
  handle?: React.ReactNode;
  primary: React.ReactNode;
  cells?: React.ReactNode[];
  aside?: React.ReactNode;
  actions?: React.ReactNode;
};

export function AdminListRow({
  grid,
  handle,
  primary,
  cells = [],
  aside,
  actions,
  className,
  ...props
}: AdminListRowProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b py-2.5 last:border-b-0 @2xl/list:grid",
        grid,
        className,
      )}
      {...props}
    >
      {handle}
      <div className="min-w-0 flex-1">{primary}</div>
      {/* In the grid, `order` moves aside and actions after the cells. */}
      {aside !== undefined ? <div className="shrink-0 @2xl/list:order-1">{aside}</div> : null}
      {actions !== undefined ? <div className="shrink-0 @2xl/list:order-2">{actions}</div> : null}
      {cells.length > 0 ? (
        <div
          className={cn(
            "flex basis-full flex-wrap items-center gap-x-4 gap-y-1 @2xl/list:contents",
            handle ? "pl-9" : undefined,
          )}
        >
          {cells.map((cell, i) => (
            <div key={i} className={CELL}>
              {cell}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AdminListSkeleton() {
  return (
    <div>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b py-3 last:border-b-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

export function AdminSearchInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
      <Input className="pl-7" aria-label={props.placeholder} {...props} />
    </div>
  );
}

export function AdminFilterTabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (value: T) => void;
  items: readonly { value: T; label: React.ReactNode }[];
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)}>
      <AnimatedTabsList items={items} value={value} className="group-data-horizontal/tabs:h-7" />
    </Tabs>
  );
}
