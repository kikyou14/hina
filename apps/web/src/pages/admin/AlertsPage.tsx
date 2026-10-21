import * as React from "react";
import { useTranslation } from "react-i18next";

import { AnimatedTabsList } from "@/components/AnimatedTabsList";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatIsoShort, formatTimeAgo } from "@/lib/time";
import { getUserErrorMessage } from "@/lib/userErrors";
import { AlertChannelsPanel } from "@/pages/admin/AlertChannelsPanel";
import { AlertRulesPanel } from "@/pages/admin/AlertRulesPanel";
import { useAdminActiveAlerts, useAdminAlertNotifications } from "@/queries/adminAlerts";
import { BADGE_TINT, SeverityBadge } from "./components/AdminBadges";
import { AdminFilterTabs, AdminList, AdminListRow } from "./components/AdminList";
import { AdminPageHeader } from "./components/AdminPageHeader";

// Tracks: rule, agent, active since, value, severity.
const ACTIVE_GRID = "@2xl/list:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_6rem_minmax(0,1fr)_5rem]";
// Tracks: rule, kind, channel, event time, status.
const NOTIFICATION_GRID = "@2xl/list:grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)_7.5rem_5rem]";

const NOTIFICATION_STATUSES = ["pending", "sent", "dead"] as const;
type NotificationFilter = "all" | (typeof NOTIFICATION_STATUSES)[number];

export function AlertsPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("alerts.title"));
  const { timezone } = useSiteConfig();
  const nowMs = Date.now();

  const [tab, setTab] = React.useState("active");
  const [status, setStatus] = React.useState<NotificationFilter>("all");
  const active = useAdminActiveAlerts({ enabled: tab === "active" });
  const notifications = useAdminAlertNotifications(status === "all" ? undefined : status, {
    enabled: tab === "notifications",
  });

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

  const statusItems = [
    { value: "all" as const, label: t("common.all") },
    ...NOTIFICATION_STATUSES.map((s) => ({
      value: s,
      label: t(`alerts.notifications.statuses.${s}`),
    })),
  ];

  const alerts = active.data?.alerts ?? [];
  const notificationList = notifications.data?.notifications ?? [];

  return (
    <div className="space-y-4">
      <AdminPageHeader title={t("alerts.title")} />

      <Tabs value={tab} onValueChange={setTab}>
        <AnimatedTabsList items={tabItems} value={tab} />

        <TabsContent value="active" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="text-muted-foreground">
                {active.isLoading ? (
                  <Skeleton className="h-4 w-16" />
                ) : (
                  t("alerts.active.count", { count: alerts.length })
                )}
              </div>
            </CardHeader>
            <CardContent>
              {active.isError ? (
                <div className="text-destructive text-sm" role="alert">
                  {getUserErrorMessage(active.error, t, { action: "load" })}
                </div>
              ) : (
                <AdminList
                  grid={ACTIVE_GRID}
                  columns={[
                    t("alerts.active.rule"),
                    t("alerts.active.agent"),
                    t("alerts.active.activeSince"),
                    t("alerts.active.value"),
                    t("alerts.active.severity"),
                  ]}
                  count={alerts.length}
                  loading={active.isLoading}
                  empty={t("common.noData")}
                >
                  {alerts.map((a, i) => (
                    <AdminListRow
                      key={`${a.rule.id}:${i}`}
                      grid={ACTIVE_GRID}
                      primary={
                        <>
                          <div className="truncate text-sm font-medium" title={a.rule.name}>
                            {a.rule.name}
                          </div>
                          <div className="text-muted-foreground mt-0.5 truncate leading-4">
                            {t(`alerts.kinds.${a.rule.kind}`, a.rule.kind)}
                          </div>
                        </>
                      }
                      cells={[
                        a.agentName ? <div className="truncate">{a.agentName}</div> : null,
                        a.activeSinceMs
                          ? formatTimeAgo(a.activeSinceMs, nowMs, i18n.language)
                          : null,
                        a.valueSummary ? (
                          <div className="text-muted-foreground break-words">{a.valueSummary}</div>
                        ) : null,
                      ]}
                      aside={<SeverityBadge severity={a.rule.severity} />}
                    />
                  ))}
                </AdminList>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-muted-foreground">
                  {notifications.isLoading ? (
                    <Skeleton className="h-4 w-16" />
                  ) : (
                    t("alerts.notifications.count", { count: notificationList.length })
                  )}
                </div>
                <AdminFilterTabs value={status} onChange={setStatus} items={statusItems} />
              </div>
            </CardHeader>
            <CardContent>
              {notifications.isError ? (
                <div className="text-destructive text-sm" role="alert">
                  {getUserErrorMessage(notifications.error, t, { action: "load" })}
                </div>
              ) : (
                <AdminList
                  grid={NOTIFICATION_GRID}
                  columns={[
                    t("alerts.notifications.rule"),
                    t("alerts.notifications.kind"),
                    t("alerts.notifications.channel"),
                    t("alerts.notifications.event"),
                    t("alerts.notifications.status"),
                  ]}
                  count={notificationList.length}
                  loading={notifications.isLoading}
                  empty={t("common.noData")}
                >
                  {notificationList.map((n) => (
                    <AdminListRow
                      key={n.id}
                      grid={NOTIFICATION_GRID}
                      primary={
                        <>
                          <div className="truncate text-sm font-medium">
                            {n.rule.name ?? n.rule.id}
                          </div>
                          {n.lastError ? (
                            <div className="text-destructive mt-0.5 leading-4 break-words">
                              {n.lastError}
                            </div>
                          ) : null}
                        </>
                      }
                      cells={[
                        <Badge className={n.kind === "firing" ? BADGE_TINT.red : BADGE_TINT.green}>
                          {t(`alerts.notifications.${n.kind}`)}
                        </Badge>,
                        <div className="truncate">
                          {n.channel.name ?? n.channel.id}
                          {n.channel.type ? (
                            <span className="text-muted-foreground ml-1">({n.channel.type})</span>
                          ) : null}
                        </div>,
                        <span className="tabular-nums">
                          {formatIsoShort(n.eventTsMs, timezone)}
                        </span>,
                      ]}
                      aside={
                        <Badge
                          className={
                            n.status === "dead"
                              ? undefined
                              : n.status === "sent"
                                ? BADGE_TINT.green
                                : BADGE_TINT.yellow
                          }
                          variant={n.status === "dead" ? "destructive" : undefined}
                        >
                          {t(`alerts.notifications.statuses.${n.status}`, n.status)}
                        </Badge>
                      }
                    />
                  ))}
                </AdminList>
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
