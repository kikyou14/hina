import * as React from "react";
import { useTranslation } from "react-i18next";

import { AnimatedTabsList } from "@/components/AnimatedTabsList";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatIsoShort, formatTimeAgo } from "@/lib/time";
import { getUserErrorMessage } from "@/lib/userErrors";
import { AlertChannelsPanel } from "@/pages/admin/AlertChannelsPanel";
import { AlertRulesPanel } from "@/pages/admin/AlertRulesPanel";
import { useAdminActiveAlerts, useAdminAlertNotifications } from "@/queries/adminAlerts";

const NOTIFICATION_STATUSES = ["pending", "sent", "dead"] as const;

export function AlertsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("alerts.title"));
  const { timezone } = useSiteConfig();
  const nowMs = Date.now();

  const active = useAdminActiveAlerts();
  const [tab, setTab] = React.useState("active");
  const [status, setStatus] = React.useState("all");
  const notifications = useAdminAlertNotifications(status === "all" ? undefined : status);

  const tabItems = React.useMemo(
    () =>
      [
        { value: "active", label: t("alerts.tabs.active") },
        { value: "notifications", label: t("alerts.tabs.notifications") },
        { value: "rules", label: t("settings.tabs.rules") },
        { value: "channels", label: t("settings.tabs.channels") },
      ] as const,
    [t],
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xl font-semibold">{t("alerts.title")}</div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <AnimatedTabsList items={tabItems} value={tab} />

        <TabsContent value="active" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <CardTitle>{t("alerts.active.title")}</CardTitle>
                  <CardDescription>
                    {active.isLoading ? (
                      <Skeleton className="inline-block h-4 w-16 align-middle" />
                    ) : (
                      t("alerts.active.count", {
                        count: active.data?.alerts.length ?? 0,
                      })
                    )}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {active.isError ? (
                <div className="text-destructive text-sm" role="alert">
                  {getUserErrorMessage(active.error, t, { action: "load" })}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("alerts.active.severity")}</TableHead>
                      <TableHead>{t("alerts.active.rule")}</TableHead>
                      <TableHead>{t("alerts.active.kind")}</TableHead>
                      <TableHead>{t("alerts.active.agent")}</TableHead>
                      <TableHead>{t("alerts.active.activeSince")}</TableHead>
                      <TableHead>{t("alerts.active.value")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(active.data?.alerts ?? []).map((a, i) => (
                      <TableRow key={`${a.rule.id}:${i}`}>
                        <TableCell>
                          <Badge
                            className={
                              a.rule.severity === "critical"
                                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                : a.rule.severity === "warning"
                                  ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                                  : ""
                            }
                            variant={a.rule.severity === "info" ? "outline" : undefined}
                          >
                            {t(`alerts.severities.${a.rule.severity}`, a.rule.severity)}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-medium">{a.rule.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {t(`alerts.kinds.${a.rule.kind}`, a.rule.kind)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{a.agentName ?? "-"}</TableCell>
                        <TableCell className="text-sm">
                          {a.activeSinceMs ? formatTimeAgo(a.activeSinceMs, nowMs) : "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {a.valueSummary ?? "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <CardTitle>{t("alerts.notifications.title")}</CardTitle>
                  <CardDescription>
                    {notifications.isLoading ? (
                      <Skeleton className="inline-block h-4 w-16 align-middle" />
                    ) : (
                      t("alerts.notifications.count", {
                        count: notifications.data?.notifications.length ?? 0,
                      })
                    )}
                  </CardDescription>
                </div>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder={t("alerts.notifications.allStatuses")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("alerts.notifications.allStatuses")}</SelectItem>
                    {NOTIFICATION_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`alerts.notifications.statuses.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {notifications.isError ? (
                <div className="text-destructive text-sm" role="alert">
                  {getUserErrorMessage(notifications.error, t, { action: "load" })}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("alerts.notifications.status")}</TableHead>
                      <TableHead>{t("alerts.notifications.kind")}</TableHead>
                      <TableHead>{t("alerts.notifications.rule")}</TableHead>
                      <TableHead>{t("alerts.notifications.channel")}</TableHead>
                      <TableHead>{t("alerts.notifications.event")}</TableHead>
                      <TableHead>{t("alerts.notifications.error")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(notifications.data?.notifications ?? []).map((n) => (
                      <TableRow key={n.id}>
                        <TableCell>
                          <Badge
                            className={
                              n.status === "sent"
                                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                : n.status === "dead"
                                  ? ""
                                  : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                            }
                            variant={n.status === "dead" ? "destructive" : undefined}
                          >
                            {t(`alerts.notifications.statuses.${n.status}`, n.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={
                              n.kind === "firing"
                                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                : "bg-green-500/10 text-green-600 dark:text-green-400"
                            }
                          >
                            {t(`alerts.notifications.${n.kind}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {n.rule.name ?? n.rule.id}
                        </TableCell>
                        <TableCell className="text-sm">
                          {n.channel.name ?? n.channel.id}
                          <span className="text-muted-foreground ml-1 text-xs">
                            {n.channel.type ? `(${n.channel.type})` : ""}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatIsoShort(n.eventTsMs, timezone)}
                        </TableCell>
                        <TableCell className="text-destructive text-xs">
                          {n.lastError ?? ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="space-y-4">
          <AlertRulesPanel />
        </TabsContent>

        <TabsContent value="channels" className="space-y-4">
          <AlertChannelsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
