import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, Trash2, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  createAdminProbeTask,
  deleteAdminProbeTask,
  patchAdminProbeTask,
  reorderAdminProbeTasks,
} from "@/api/adminProbes";
import type { AdminProbeTask, ProbeKind } from "@/api/adminProbes";
import { AdminPagination } from "@/components/AdminPagination";
import { useConfirm } from "@/components/ConfirmDialog";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatProbeTarget } from "@/lib/probes";
import { useAdminAgentOptions } from "@/queries/adminAgents";
import { invalidateAdminGroups, useAdminGroups } from "@/queries/adminGroups";
import { useAdminProbeTasks } from "@/queries/adminProbes";
import { EnabledBadge, ProbeKindBadge } from "./components/AdminBadges";
import { AdminFilterTabs, AdminList, AdminSearchInput } from "./components/AdminList";
import { AdminPageHeader } from "./components/AdminPageHeader";
import { ProbeTaskForm } from "./components/ProbeTaskForm";
import { RowActions } from "./components/RowActions";
import { SortableList, SortableRow } from "./components/SortableList";
import { SELECT_ALL_VALUE } from "./lib/probeValidation";
import { useReorderMutation } from "./lib/reorder";

// Tracks: handle, task, kind, interval, scope, status, actions.
const PROBE_GRID =
  "@2xl/list:grid-cols-[1.5rem_minmax(0,1.4fr)_5.5rem_3.5rem_minmax(0,0.8fr)_4.5rem_4.25rem]";

type EnabledFilter = "all" | "enabled" | "disabled";

const SEARCH_DEBOUNCE_MS = 250;

function ProbeScope({ task: tsk }: { task: AdminProbeTask }) {
  const { t } = useTranslation();
  if (tsk.allAgents) return <>{t("scope.modes.all")}</>;
  if (tsk.groups.length > 0) return <>{tsk.groups.map((g) => g.name).join(", ")}</>;
  return <>{t("probes.table.agents", { count: tsk.agents.length })}</>;
}

function ProbeUnsupportedWarning({ task: tsk }: { task: AdminProbeTask }) {
  const { t } = useTranslation();
  const support = tsk.capabilitySupport;
  if (!support || support.unsupportedAgents === 0) return null;

  const keys = "probes.capabilityUnsupported";
  const runsNowhere = support.targetAgents - support.unsupportedAgents === 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
        runsNowhere
          ? "bg-red-500/10 text-red-600 dark:text-red-400"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      }`}
      title={
        runsNowhere
          ? t(`${keys}.noneTitle`, { total: support.targetAgents })
          : t(`${keys}.someTitle`, {
              unsupported: support.unsupportedAgents,
              total: support.targetAgents,
            })
      }
    >
      <AlertTriangle className="size-3 shrink-0" />
      {runsNowhere
        ? t(`${keys}.noneLabel`)
        : t(`${keys}.someLabel`, {
            unsupported: support.unsupportedAgents,
            total: support.targetAgents,
          })}
    </span>
  );
}

function ProbeTaskIdentity({ task: tsk }: { task: AdminProbeTask }) {
  const target = formatProbeTarget(tsk.kind as ProbeKind, tsk.target);
  return (
    <>
      <div className="truncate text-sm font-medium" title={tsk.name}>
        {tsk.name}
      </div>
      <div className="text-muted-foreground mt-0.5 truncate font-mono leading-4" title={target}>
        {target}
      </div>
    </>
  );
}

export function ProbeTasksPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("probes.title"));
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [q, setQ] = React.useState("");
  const [kind, setKind] = React.useState<ProbeKind | "">("");
  const [enabled, setEnabled] = React.useState<EnabledFilter>("all");
  const [limit, setLimit] = React.useState(50);
  const [offset, setOffset] = React.useState(0);

  // Filter setters reset offset in the same update so no request goes out with
  // a stale offset.
  const onQChange = (v: string) => {
    setQ(v);
    setOffset(0);
  };
  const onKindChange = (v: ProbeKind | "") => {
    setKind(v);
    setOffset(0);
  };
  const onEnabledChange = (v: EnabledFilter) => {
    setEnabled(v);
    setOffset(0);
  };
  const clearFilters = () => {
    setQ("");
    setKind("");
    setEnabled("all");
    setOffset(0);
  };

  // Wait for typing to pause so each keystroke doesn't send a request.
  const searchQ = useDebouncedValue(q.trim(), SEARCH_DEBOUNCE_MS);
  const query = React.useMemo(() => {
    return {
      q: searchQ || undefined,
      kind: kind || undefined,
      enabled: enabled === "all" ? undefined : enabled === "enabled",
      limit,
      offset,
    };
  }, [searchQ, kind, enabled, limit, offset]);

  const hasFilters = !!(query.q || query.kind || query.enabled !== undefined);

  const tasksQuery = useAdminProbeTasks(query);

  const agents = useAdminAgentOptions();
  const groups = useAdminGroups();

  const invalidateProbeTasks = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "probeTasks"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "options", "probeTasks"] }),
    ]);
  }, [queryClient]);

  const invalidateProbeTasksAndGroups = React.useCallback(async () => {
    await Promise.all([invalidateProbeTasks(), invalidateAdminGroups(queryClient)]);
  }, [invalidateProbeTasks, queryClient]);

  const createTask = useMutation({
    mutationFn: createAdminProbeTask,
    onSuccess: invalidateProbeTasks,
  });

  const updateTask = useMutation({
    mutationFn: async (args: {
      taskId: string;
      patch: Parameters<typeof patchAdminProbeTask>[1];
    }) => patchAdminProbeTask(args.taskId, args.patch),
    onSuccess: invalidateProbeTasksAndGroups,
  });

  const removeTask = useMutation({
    mutationFn: deleteAdminProbeTask,
    onSuccess: invalidateProbeTasksAndGroups,
  });

  const handleDeleteTask = (taskId: string) => {
    void confirm({
      title: t("common.confirmDelete"),
      description: t("probes.deleteConfirm"),
      confirmText: t("common.delete"),
      variant: "destructive",
      onConfirm: () => removeTask.mutateAsync(taskId),
      errorMessage: t("probes.deleteFailed"),
    });
  };

  const reorder = useReorderMutation({
    listKey: ["admin", "probeTasks"],
    queryKey: ["admin", "probeTasks", query],
    field: "tasks",
    mutationFn: reorderAdminProbeTasks,
    errorMessage: t("probes.reorderFailed"),
  });

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminProbeTask | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);

  const tasks = tasksQuery.data?.tasks ?? [];
  const total = tasksQuery.data?.total ?? 0;
  // Reorder rewrites displayOrder for the visible set; disable drag when filters
  // are active, the slice is truncated, or the previous query's rows are still
  // shown, otherwise it would clobber rows that aren't on screen.
  const isTruncated = total > tasks.length;
  const canDrag = !hasFilters && !isTruncated && !tasksQuery.isPlaceholderData;

  const enabledItems = [
    { value: "all", label: t("common.all") },
    { value: "enabled", label: t("common.enabled") },
    { value: "disabled", label: t("common.disabled") },
  ] as const;

  return (
    <div className="space-y-4">
      <AdminPageHeader
        title={t("probes.title")}
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus data-icon="inline-start" />
                {t("probes.createTask")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm" scrollBehavior="viewport">
              <DialogHeader>
                <DialogTitle>{t("probes.createDialog.title")}</DialogTitle>
              </DialogHeader>
              <ProbeTaskForm
                mode="create"
                agents={agents.data?.agents ?? []}
                groups={groups.data ?? []}
                pending={createTask.isPending}
                onSubmit={async (v) => {
                  await createTask.mutateAsync(v);
                  setCreateOpen(false);
                }}
              />
            </DialogContent>
          </Dialog>
        }
      />

      {tasksQuery.isError ? (
        <QueryErrorCard
          error={tasksQuery.error}
          retrying={tasksQuery.isFetching}
          onRetry={() => tasksQuery.refetch()}
        />
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <AdminSearchInput
              value={q}
              onChange={(e) => onQChange(e.target.value)}
              placeholder={t("probes.filters.taskNamePlaceholder")}
            />
            <Select
              value={kind}
              onValueChange={(v) => onKindChange(v === SELECT_ALL_VALUE ? "" : (v as ProbeKind))}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder={t("probes.filters.kind")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_ALL_VALUE}>{t("common.all")}</SelectItem>
                <SelectItem value="icmp">icmp</SelectItem>
                <SelectItem value="tcp">tcp</SelectItem>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="traceroute">traceroute</SelectItem>
              </SelectContent>
            </Select>
            <AdminFilterTabs value={enabled} onChange={onEnabledChange} items={enabledItems} />
            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X data-icon="inline-start" />
                {t("common.clear")}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <AdminList
            grid={PROBE_GRID}
            columns={[
              "",
              t("probes.table.name"),
              t("probes.table.kind"),
              t("probes.table.interval"),
              t("probes.form.agents"),
              t("probes.table.status"),
              "",
            ]}
            count={tasks.length}
            loading={tasksQuery.isLoading}
            empty={
              tasksQuery.isError ? null : hasFilters ? t("common.noMatches") : t("common.noData")
            }
          >
            <SortableList ids={tasks.map((tsk) => tsk.id)} onReorder={(ids) => reorder.mutate(ids)}>
              {tasks.map((tsk) => (
                <SortableRow
                  key={tsk.id}
                  id={tsk.id}
                  draggable={canDrag}
                  grid={PROBE_GRID}
                  primary={<ProbeTaskIdentity task={tsk} />}
                  cells={[
                    <ProbeKindBadge kind={tsk.kind as ProbeKind} />,
                    <span className="tabular-nums">{tsk.intervalSec}s</span>,
                    <div className="flex flex-col items-start gap-1">
                      <span className="max-w-full truncate">
                        <ProbeScope task={tsk} />
                      </span>
                      <ProbeUnsupportedWarning task={tsk} />
                    </div>,
                  ]}
                  aside={<EnabledBadge enabled={tsk.enabled} />}
                  actions={
                    <RowActions
                      onEdit={() => {
                        setEditing(tsk);
                        setEditOpen(true);
                      }}
                      menu={[
                        {
                          label: t("common.delete"),
                          icon: Trash2,
                          destructive: true,
                          disabled: removeTask.isPending,
                          onSelect: () => handleDeleteTask(tsk.id),
                        },
                      ]}
                    />
                  }
                />
              ))}
            </SortableList>
          </AdminList>
          <AdminPagination
            className="mt-4"
            total={total}
            limit={limit}
            offset={offset}
            onOffsetChange={setOffset}
            onLimitChange={setLimit}
          />
        </CardContent>
      </Card>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          if (!open) setEditOpen(false);
        }}
      >
        <DialogContent className="max-w-sm" scrollBehavior="viewport">
          <DialogHeader>
            <DialogTitle>{t("probes.editDialog.title")}</DialogTitle>
          </DialogHeader>
          {editing ? (
            <ProbeTaskForm
              mode="edit"
              task={editing}
              agents={agents.data?.agents ?? []}
              groups={groups.data ?? []}
              pending={updateTask.isPending}
              onSubmit={async (v) => {
                await updateTask.mutateAsync({ taskId: editing.id, patch: v });
                setEditOpen(false);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
