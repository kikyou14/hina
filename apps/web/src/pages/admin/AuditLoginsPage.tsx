import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { LOGIN_ATTEMPT_REASONS, getAdminLoginAudit } from "@/api/adminAudit";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatIsoShort } from "@/lib/time";
import { getUserErrorMessage } from "@/lib/userErrors";
import { AdminFilterTabs, AdminList, AdminListRow } from "./components/AdminList";
import { AdminPageHeader } from "./components/AdminPageHeader";

// Tracks: time, result, reason, username, IP.
const AUDIT_GRID = "@2xl/list:grid-cols-[8rem_5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

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

  const filterItems = [
    { value: "all", label: t("audit.logins.filter.all") },
    { value: "failures", label: t("audit.logins.filter.failures") },
  ] as const;

  const logs = audit.data?.logs ?? [];

  return (
    <div className="space-y-4">
      <AdminPageHeader title={t("audit.logins.title")} />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <AdminFilterTabs value={filter} onChange={setFilterAndReset} items={filterItems} />

            <div className="flex items-center gap-2">
              <Label htmlFor="audit-logins-limit" className="text-muted-foreground">
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
                className="w-20"
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset((v) => Math.max(0, v - limit))}
                disabled={offset <= 0}
              >
                {t("audit.logins.prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset((v) => v + limit)}
                disabled={!audit.data?.hasMore}
              >
                {t("audit.logins.next")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {audit.isError ? (
            <div className="text-destructive text-sm" role="alert">
              {getUserErrorMessage(audit.error, t, { action: "load" })}
            </div>
          ) : (
            <AdminList
              grid={AUDIT_GRID}
              columns={[
                t("audit.logins.table.time"),
                t("audit.logins.table.result"),
                t("audit.logins.table.reason"),
                t("audit.logins.table.username"),
                t("audit.logins.table.ip"),
              ]}
              count={logs.length}
              loading={audit.isLoading}
              empty={t("audit.logins.noLogs")}
            >
              {logs.map((row, idx) => (
                <AdminListRow
                  key={`${row.tsMs}:${idx}`}
                  grid={AUDIT_GRID}
                  title={row.userAgent ?? undefined}
                  className={row.success ? undefined : "bg-destructive/5"}
                  primary={
                    <span className="font-mono tabular-nums">
                      {formatIsoShort(row.tsMs, timezone)}
                    </span>
                  }
                  cells={[
                    <ResultBadge
                      success={row.success}
                      successLabel={t("audit.logins.result.success")}
                      failureLabel={t("audit.logins.result.failure")}
                    />,
                    KNOWN_REASONS.has(row.reason) ? (
                      <span className="text-muted-foreground">
                        {t(`audit.logins.reason.${row.reason}`)}
                      </span>
                    ) : null,
                    row.usernameAttempted ? (
                      <div className="font-mono break-all">{row.usernameAttempted}</div>
                    ) : null,
                    row.ip ? <div className="font-mono break-all">{row.ip}</div> : null,
                  ]}
                />
              ))}
            </AdminList>
          )}
        </CardContent>
      </Card>
    </div>
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
