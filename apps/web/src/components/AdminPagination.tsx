import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type AdminPaginationProps = {
  total: number;
  limit: number;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onLimitChange?: (limit: number) => void;
  pageSizeOptions?: number[];
  className?: string;
};

const DEFAULT_PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500];

export function AdminPagination({
  total,
  limit,
  offset,
  onOffsetChange,
  onLimitChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  className,
}: AdminPaginationProps) {
  const { t } = useTranslation();

  const safeLimit = Math.max(1, limit);
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const lastPageOffset = Math.max(0, (totalPages - 1) * safeLimit);
  const clampedOffset = total === 0 ? 0 : Math.min(Math.max(0, offset), lastPageOffset);

  const onOffsetChangeRef = React.useRef(onOffsetChange);
  React.useEffect(() => {
    onOffsetChangeRef.current = onOffsetChange;
  });

  React.useEffect(() => {
    if (total > 0 && offset !== clampedOffset) {
      onOffsetChangeRef.current(clampedOffset);
    }
  }, [total, offset, clampedOffset]);

  if (total === 0) return null;

  const currentPage = Math.floor(clampedOffset / safeLimit) + 1;
  const start = clampedOffset + 1;
  const end = Math.min(total, clampedOffset + safeLimit);

  const canPrev = clampedOffset > 0;
  const canNext = clampedOffset + safeLimit < total;

  const showNav = total > safeLimit;

  const goFirst = () => onOffsetChange(0);
  const goPrev = () => onOffsetChange(Math.max(0, clampedOffset - safeLimit));
  const goNext = () => onOffsetChange(clampedOffset + safeLimit);
  const goLast = () => onOffsetChange(lastPageOffset);

  return (
    <nav
      aria-label="pagination"
      className={cn(
        "flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span aria-live="polite" className="tabular-nums">
          {t("common.pagination.rangeOfTotal", { start, end, total })}
        </span>
        {onLimitChange && pageSizeOptions.length > 1 ? (
          <Select
            value={String(limit)}
            onValueChange={(v) => {
              const next = Number.parseInt(v, 10);
              if (!Number.isFinite(next) || next <= 0) return;
              onLimitChange(next);
              onOffsetChange(0);
            }}
          >
            <SelectTrigger className="min-w-26" aria-label={t("common.pagination.pageSize")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t("common.pagination.pageSizeOption", { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {showNav ? (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={goFirst}
            disabled={!canPrev}
            aria-label={t("common.pagination.first")}
            title={t("common.pagination.first")}
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={goPrev}
            disabled={!canPrev}
            aria-label={t("common.pagination.previous")}
          >
            <ChevronLeft data-icon="inline-start" />
            <span className="hidden sm:inline">{t("common.pagination.previous")}</span>
          </Button>
          <span className="text-muted-foreground px-2 text-xs tabular-nums">
            {currentPage} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={goNext}
            disabled={!canNext}
            aria-label={t("common.pagination.next")}
          >
            <span className="hidden sm:inline">{t("common.pagination.next")}</span>
            <ChevronRight data-icon="inline-end" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={goLast}
            disabled={!canNext}
            aria-label={t("common.pagination.last")}
            title={t("common.pagination.last")}
          >
            <ChevronsRight />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
