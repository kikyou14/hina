import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { AdminAlertRule } from "@/api/adminAlerts";
import { createAdminAlertRule, deleteAdminAlertRule, patchAdminAlertRule } from "@/api/adminAlerts";
import { AdminPagination } from "@/components/AdminPagination";
import { useConfirm } from "@/components/ConfirmDialog";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIsoShort } from "@/lib/time";
import { useAdminAgentOptions } from "@/queries/adminAgents";
import { useAdminAlertChannelOptions, useAdminAlertRules } from "@/queries/adminAlerts";
import { invalidateAdminGroups, useAdminGroups } from "@/queries/adminGroups";
import { useAdminProbeTaskOptions } from "@/queries/adminProbes";
import { EnabledBadge, SeverityBadge } from "./components/AdminBadges";
import { AdminList, AdminListRow } from "./components/AdminList";
import { AlertRuleForm } from "./components/AlertRuleForm";
import { RowActions } from "./components/RowActions";

// Tracks: rule, severity, channels, updated, status, actions.
const RULE_GRID = "@2xl/list:grid-cols-[minmax(0,1.4fr)_5rem_minmax(0,1fr)_7.5rem_4.5rem_4.25rem]";

function RuleIdentity({ rule: r }: { rule: AdminAlertRule }) {
  const { t } = useTranslation();
  // Expiry and route-change rules don't use the for/recover delay.
  const hasDelay = r.kind !== "agent_expiring" && r.kind !== "route_change";
  const meta = [
    t(`alerts.kinds.${r.kind}`, r.kind),
    hasDelay &&
      `${t("settings.rules.table.delay")} ${Math.round(r.forMs / 1000)}s / ${Math.round(r.recoverMs / 1000)}s`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="truncate text-sm font-medium" title={r.name}>
        {r.name}
      </div>
      <div className="text-muted-foreground mt-0.5 truncate leading-4">{meta}</div>
    </>
  );
}

export function AlertRulesPanel() {
  const { t } = useTranslation();
  const { timezone } = useSiteConfig();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [limit, setLimit] = React.useState(50);
  const [offset, setOffset] = React.useState(0);

  const channels = useAdminAlertChannelOptions();
  const rules = useAdminAlertRules({ limit, offset });

  const agents = useAdminAgentOptions();

  const groups = useAdminGroups();

  const probeTasks = useAdminProbeTaskOptions();

  const invalidateAlertRules = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "alertRules"] });
  }, [queryClient]);

  const invalidateAlertRulesAndActiveAlerts = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "alertRules"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "activeAlerts"] }),
    ]);
  }, [queryClient]);

  const invalidateAlertRulesActiveAlertsAndGroups = React.useCallback(async () => {
    await Promise.all([invalidateAlertRulesAndActiveAlerts(), invalidateAdminGroups(queryClient)]);
  }, [invalidateAlertRulesAndActiveAlerts, queryClient]);

  const createRule = useMutation({
    mutationFn: createAdminAlertRule,
    onSuccess: invalidateAlertRules,
  });
  const updateRule = useMutation({
    mutationFn: async (args: {
      ruleId: string;
      patch: Parameters<typeof patchAdminAlertRule>[1];
    }) => patchAdminAlertRule(args.ruleId, args.patch),
    onSuccess: invalidateAlertRulesActiveAlertsAndGroups,
  });
  const removeRule = useMutation({
    mutationFn: deleteAdminAlertRule,
    onSuccess: invalidateAlertRulesActiveAlertsAndGroups,
  });

  const [createRuleOpen, setCreateRuleOpen] = React.useState(false);
  const [editRule, setEditRule] = React.useState<AdminAlertRule | null>(null);

  const handleDeleteRule = (ruleId: string) => {
    void confirm({
      title: t("common.confirmDelete"),
      description: t("settings.rules.deleteConfirm"),
      confirmText: t("common.delete"),
      variant: "destructive",
      onConfirm: () => removeRule.mutateAsync(ruleId),
      errorMessage: t("settings.rules.deleteFailed"),
    });
  };

  const ruleList = rules.data?.rules ?? [];

  return (
    <>
      {rules.isError ? (
        <QueryErrorCard
          error={rules.error}
          retrying={rules.isFetching}
          onRetry={() => rules.refetch()}
        />
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="text-muted-foreground">
              {rules.isLoading ? (
                <Skeleton className="h-4 w-16" />
              ) : (
                t("settings.rules.table.count", { count: rules.data?.total ?? 0 })
              )}
            </div>
            <Dialog open={createRuleOpen} onOpenChange={setCreateRuleOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus data-icon="inline-start" />
                  {t("settings.rules.createRule")}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl" scrollBehavior="viewport">
                <DialogHeader>
                  <DialogTitle>{t("settings.rules.createDialog.title")}</DialogTitle>
                </DialogHeader>
                <AlertRuleForm
                  mode="create"
                  agents={agents.data?.agents ?? []}
                  groups={groups.data ?? []}
                  probeTasks={probeTasks.data?.tasks ?? []}
                  channels={channels.data?.channels ?? []}
                  pending={createRule.isPending}
                  onSubmit={async (v) => {
                    await createRule.mutateAsync(v as Parameters<typeof createAdminAlertRule>[0]);
                    setCreateRuleOpen(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          <AdminList
            grid={RULE_GRID}
            columns={[
              t("settings.rules.table.name"),
              t("settings.rules.table.severity"),
              t("settings.rules.table.channels"),
              t("settings.rules.table.updated"),
              t("settings.rules.table.status"),
              "",
            ]}
            count={ruleList.length}
            loading={rules.isLoading}
            empty={rules.isError ? null : t("common.noData")}
          >
            {ruleList.map((r) => {
              const channelNames = r.channels.map((ch) => ch.name).join(", ");
              return (
                <AdminListRow
                  key={r.id}
                  grid={RULE_GRID}
                  primary={<RuleIdentity rule={r} />}
                  cells={[
                    <SeverityBadge severity={r.severity} />,
                    channelNames ? (
                      <div className="truncate" title={channelNames}>
                        {channelNames}
                      </div>
                    ) : null,
                    <span className="tabular-nums">{formatIsoShort(r.updatedAtMs, timezone)}</span>,
                  ]}
                  aside={<EnabledBadge enabled={r.enabled} />}
                  actions={
                    <RowActions
                      onEdit={() => setEditRule(r)}
                      menu={[
                        {
                          label: t("common.delete"),
                          icon: Trash2,
                          destructive: true,
                          disabled: removeRule.isPending,
                          onSelect: () => handleDeleteRule(r.id),
                        },
                      ]}
                    />
                  }
                />
              );
            })}
          </AdminList>
          <AdminPagination
            className="mt-4"
            total={rules.data?.total ?? 0}
            limit={limit}
            offset={offset}
            onOffsetChange={setOffset}
            onLimitChange={setLimit}
          />
        </CardContent>
      </Card>

      {editRule ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditRule(null);
          }}
        >
          <DialogContent className="max-w-xl" scrollBehavior="viewport">
            <DialogHeader>
              <DialogTitle>{t("settings.rules.editDialog.title")}</DialogTitle>
            </DialogHeader>
            <AlertRuleForm
              mode="edit"
              rule={editRule}
              agents={agents.data?.agents ?? []}
              groups={groups.data ?? []}
              probeTasks={probeTasks.data?.tasks ?? []}
              channels={channels.data?.channels ?? []}
              pending={updateRule.isPending}
              onSubmit={async (patch) => {
                await updateRule.mutateAsync({
                  ruleId: editRule.id,
                  patch,
                });
                setEditRule(null);
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
