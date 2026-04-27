import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { LOGIN_ATTEMPT_REASONS, getAdminLoginAudit } from "@/api/adminAudit";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatIsoShort } from "@/lib/time";
import { getUserErrorMessage } from "@/lib/userErrors";
import { cn } from "@/lib/utils";

type FilterValue = "all" | "failures";

// Runtime guard for forward-compat: if a newer server sends a reason this
// client doesn't know about, render a dash rather than a raw untranslated key.
const KNOWN_REASONS: ReadonlySet<string> = new Set(LOGIN_ATTEMPT_REASONS);

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (!Number.isInteger(value)) return Math.min(Math.max(Math.round(value), min), max);
  return Math.min(Math.max(value, min), max);
}

export function AuditLoginsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("audit.logins.title"));
  const { timezone } = useSiteConfig();

  const [limit, setLimit] = React.useState(50);
  const [offset, setOffset] = React.useState(0);
  const [filter, setFilter] = React.useState<FilterValue>("all");

  const onlyFailures = filter === "failures";

  const audit = useQuery({
    queryKey: ["admin", "audit", "logins", limit, offset, onlyFailures],
    queryFn: () => getAdminLoginAudit({ limit, offset, onlyFailures }),
    staleTime: 10_000,
  });

  const setFilterAndReset = (next: FilterValue) => {
    setFilter(next);
    setOffset(0);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("audit.logins.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <FilterToggle
            value={filter}
            onChange={setFilterAndReset}
            labels={{
              all: t("audit.logins.filter.all"),
              failures: t("audit.logins.filter.failures"),
            }}
          />

          <div className="flex items-center gap-2">
            <Label htmlFor="audit-logins-limit" className="text-muted-foreground text-sm">
              {t("audit.logins.limit")}
            </Label>
            <Input
              id="audit-logins-limit"
              type="number"
              value={limit}
              onChange={(e) => {
                const next = clampInt(Number(e.target.value) || 50, 10, 200);
                setLimit(next);
                setOffset(0);
              }}
              className="w-28"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setOffset((v) => Math.max(0, v - limit))}
              disabled={offset <= 0}
            >
              {t("audit.logins.prev")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setOffset((v) => v + limit)}
              disabled={!audit.data?.hasMore}
            >
              {t("audit.logins.next")}
            </Button>
          </div>
        </div>

        {audit.isError ? (
          <div className="text-destructive text-sm" role="alert">
            {getUserErrorMessage(audit.error, t, { action: "load" })}
          </div>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-48">{t("audit.logins.table.time")}</TableHead>
              <TableHead className="w-26">{t("audit.logins.table.result")}</TableHead>
              <TableHead>{t("audit.logins.table.reason")}</TableHead>
              <TableHead>{t("audit.logins.table.username")}</TableHead>
              <TableHead>{t("audit.logins.table.ip")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {audit.isLoading ? (
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell>
                    <Skeleton className="h-4 w-36" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-28" />
                  </TableCell>
                </TableRow>
              ))
            ) : audit.data && audit.data.logs.length > 0 ? (
              audit.data.logs.map((row, idx) => {
                const reasonKnown = KNOWN_REASONS.has(row.reason);
                return (
                  <TableRow
                    key={`${row.tsMs}:${idx}`}
                    title={row.userAgent ?? undefined}
                    className={cn(
                      "transition-colors",
                      !row.success && "bg-destructive/5 hover:bg-destructive/10",
                    )}
                  >
                    <TableCell className="font-mono text-xs whitespace-nowrap tabular-nums">
                      {formatIsoShort(row.tsMs, timezone)}
                    </TableCell>
                    <TableCell>
                      <ResultBadge
                        success={row.success}
                        successLabel={t("audit.logins.result.success")}
                        failureLabel={t("audit.logins.result.failure")}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {reasonKnown ? t(`audit.logins.reason.${row.reason}`) : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.usernameAttempted ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.ip ?? "—"}</TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center text-sm">
                  {t("audit.logins.noLogs")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function FilterToggle({
  value,
  onChange,
  labels,
}: {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  labels: { all: string; failures: string };
}) {
  return (
    <div
      role="group"
      aria-label={labels.all + " / " + labels.failures}
      className="bg-muted inline-flex items-center rounded-md p-0.5"
    >
      <FilterButton active={value === "all"} onClick={() => onChange("all")}>
        {labels.all}
      </FilterButton>
      <FilterButton active={value === "failures"} onClick={() => onChange("failures")}>
        {labels.failures}
      </FilterButton>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring rounded-sm px-3 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ResultBadge({
  success,
  successLabel,
  failureLabel,
}: {
  success: boolean;
  successLabel: string;
  failureLabel: string;
}) {
  if (success) {
    return (
      <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">
        <CircleCheck aria-hidden="true" />
        {successLabel}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <CircleX aria-hidden="true" />
      {failureLabel}
    </Badge>
  );
}
