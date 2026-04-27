import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { AdminAlertRule } from "@/api/adminAlerts";
import { createAdminAlertRule, deleteAdminAlertRule, patchAdminAlertRule } from "@/api/adminAlerts";
import { AdminPagination } from "@/components/AdminPagination";
import { useConfirm } from "@/components/ConfirmDialog";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatIsoShort } from "@/lib/time";
import { useAdminAgentOptions } from "@/queries/adminAgents";
import { useAdminAlertChannelOptions, useAdminAlertRules } from "@/queries/adminAlerts";
import { invalidateAdminGroups, useAdminGroups } from "@/queries/adminGroups";
import { useAdminProbeTaskOptions } from "@/queries/adminProbes";
import { AlertRuleForm } from "./components/AlertRuleForm";

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
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>{t("settings.rules.table.title")}</CardTitle>
              <CardDescription>
                {rules.isLoading ? (
                  <Skeleton className="inline-block h-4 w-16 align-middle" />
                ) : (
                  t("settings.rules.table.count", {
                    count: rules.data?.total ?? 0,
                  })
                )}
              </CardDescription>
            </div>
            <Dialog open={createRuleOpen} onOpenChange={setCreateRuleOpen}>
              <DialogTrigger asChild>
                <Button>{t("settings.rules.createRule")}</Button>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.rules.table.name")}</TableHead>
                <TableHead>{t("settings.rules.table.severity")}</TableHead>
                <TableHead>{t("settings.rules.table.kind")}</TableHead>
                <TableHead>{t("settings.rules.table.status")}</TableHead>
                <TableHead>{t("settings.rules.table.delay")}</TableHead>
                <TableHead>{t("settings.rules.table.channels")}</TableHead>
                <TableHead>{t("settings.rules.table.updated")}</TableHead>
                <TableHead>{t("settings.rules.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rules.data?.rules ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge
                      className={
                        r.severity === "critical"
                          ? "bg-red-500/10 text-red-600 dark:text-red-400"
                          : r.severity === "warning"
                            ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                            : ""
                      }
                      variant={r.severity === "info" ? "outline" : undefined}
                    >
                      {t(`alerts.severities.${r.severity}`, r.severity)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`alerts.kinds.${r.kind}`, r.kind)}</Badge>
                  </TableCell>
                  <TableCell>
                    {r.enabled ? (
                      <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">
                        {t("common.enabled")}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">{t("common.disabled")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {r.kind === "agent_expiring" || r.kind === "route_change"
                      ? "\u2014"
                      : `${Math.round(r.forMs / 1000)}s / ${Math.round(r.recoverMs / 1000)}s`}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.channels.map((ch) => ch.name).join(", ") || "\u2014"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatIsoShort(r.updatedAtMs, timezone)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditRule(r)}>
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteRule(r.id)}
                        disabled={removeRule.isPending}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
