import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";
import {
  createAdminProbeTask,
  deleteAdminProbeTask,
  patchAdminProbeTask,
  reorderAdminProbeTasks,
} from "@/api/adminProbes";
import type { AdminProbeTask, AdminProbeTasksResponse, ProbeKind } from "@/api/adminProbes";
import { AdminPagination } from "@/components/AdminPagination";
import { useConfirm } from "@/components/ConfirmDialog";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatProbeTarget } from "@/lib/probes";
import { useAdminAgentOptions } from "@/queries/adminAgents";
import { invalidateAdminGroups, useAdminGroups } from "@/queries/adminGroups";
import { useAdminProbeTasks } from "@/queries/adminProbes";
import { ProbeTaskForm } from "./components/ProbeTaskForm";
import { SELECT_ALL_VALUE } from "./lib/probeValidation";
import { ProbeTasksPageSkeleton } from "./ProbeTasksPage.skeleton";

const PROBE_KIND_STYLES: Record<ProbeKind, string> = {
  icmp: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  tcp: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
  http: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
  traceroute: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
};

function ProbeKindBadge({ kind }: { kind: ProbeKind }) {
  return <Badge className={PROBE_KIND_STYLES[kind]}>{kind}</Badge>;
}

function ProbeScope({ task: tsk }: { task: AdminProbeTask }) {
  const { t } = useTranslation();
  if (tsk.allAgents) return <>{t("scope.modes.all")}</>;
  if (tsk.groups.length > 0) return <>{tsk.groups.map((g) => g.name).join(", ")}</>;
  return <>{t("probes.table.agents", { count: tsk.agents.length })}</>;
}

function ProbeStatusBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return enabled ? (
    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300">
      {t("common.enabled")}
    </Badge>
  ) : (
    <Badge variant="destructive">{t("common.disabled")}</Badge>
  );
}

function ProbeActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={onEdit}>
        {t("common.edit")}
      </Button>
      <Button variant="destructive" size="sm" onClick={onDelete}>
        {t("common.delete")}
      </Button>
    </div>
  );
}

function SortableProbeTaskRowCompact({
  task: tsk,
  onEdit,
  onDelete,
  draggable,
}: {
  task: AdminProbeTask;
  onEdit: () => void;
  onDelete: () => void;
  draggable: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tsk.id, disabled: !draggable });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className="border-b px-4 py-3 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        {draggable ? (
          <button
            ref={setActivatorNodeRef}
            {...listeners}
            className="text-muted-foreground hover:text-foreground flex cursor-grab items-center justify-center rounded p-1 active:cursor-grabbing"
            tabIndex={-1}
          >
            <GripVertical className="size-4" />
          </button>
        ) : (
          <div className="w-6" />
        )}
        <span className="min-w-0 truncate font-medium">{tsk.name}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ProbeKindBadge kind={tsk.kind as ProbeKind} />
          <ProbeStatusBadge enabled={tsk.enabled} />
        </div>
      </div>

      <div
        className="text-muted-foreground mt-1.5 pl-8 font-mono text-xs"
        title={formatProbeTarget(tsk.kind as ProbeKind, tsk.target)}
      >
        <span className="line-clamp-1">{formatProbeTarget(tsk.kind as ProbeKind, tsk.target)}</span>
      </div>

      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 text-xs">
        <span>{tsk.intervalSec}s</span>
        <span>
          <ProbeScope task={tsk} />
        </span>
      </div>

      <div className="mt-3 pl-8">
        <ProbeActions onEdit={onEdit} onDelete={onDelete} />
      </div>
    </div>
  );
}

function SortableProbeTaskRow({
  task: tsk,
  onEdit,
  onDelete,
  draggable,
}: {
  task: AdminProbeTask;
  onEdit: () => void;
  onDelete: () => void;
  draggable: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tsk.id, disabled: !draggable });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <TableRow ref={setNodeRef} style={style} {...attributes}>
      <TableCell className="w-8 px-1">
        {draggable ? (
          <button
            ref={setActivatorNodeRef}
            {...listeners}
            className="text-muted-foreground hover:text-foreground flex cursor-grab items-center justify-center rounded p-1 active:cursor-grabbing"
            tabIndex={-1}
          >
            <GripVertical className="size-4" />
          </button>
        ) : null}
      </TableCell>
      <TableCell className="font-medium">{tsk.name}</TableCell>
      <TableCell>
        <ProbeKindBadge kind={tsk.kind as ProbeKind} />
      </TableCell>
      <TableCell
        className="truncate font-mono text-xs"
        title={formatProbeTarget(tsk.kind as ProbeKind, tsk.target)}
      >
        {formatProbeTarget(tsk.kind as ProbeKind, tsk.target)}
      </TableCell>
      <TableCell>{tsk.intervalSec}s</TableCell>
      <TableCell className="text-xs">
        <ProbeScope task={tsk} />
      </TableCell>
      <TableCell>
        <ProbeStatusBadge enabled={tsk.enabled} />
      </TableCell>
      <TableCell>
        <ProbeActions onEdit={onEdit} onDelete={onDelete} />
      </TableCell>
    </TableRow>
  );
}

export function ProbeTasksPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("probes.title"));
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [q, setQ] = React.useState("");
  const [kind, setKind] = React.useState<ProbeKind | "">("");
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [limit, setLimit] = React.useState(50);
  const [offset, setOffset] = React.useState(0);

  // Filter setters reset offset synchronously so the query memo doesn't fire one
  // request with the stale offset before a useEffect catches up.
  const onQChange = (v: string) => {
    setQ(v);
    setOffset(0);
  };
  const onKindChange = (v: ProbeKind | "") => {
    setKind(v);
    setOffset(0);
  };
  const onEnabledChange = (v: boolean | null) => {
    setEnabled(v);
    setOffset(0);
  };

  const query = React.useMemo(() => {
    return {
      q: q.trim() || undefined,
      kind: kind || undefined,
      enabled: enabled === null ? undefined : enabled,
      limit,
      offset,
    };
  }, [q, kind, enabled, limit, offset]);

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

  const reorder = useMutation({
    mutationFn: reorderAdminProbeTasks,
    async onMutate(taskIds) {
      await queryClient.cancelQueries({ queryKey: ["admin", "probeTasks"] });
      const queryKey = ["admin", "probeTasks", query];
      const prev = queryClient.getQueryData<AdminProbeTasksResponse>(queryKey);
      if (prev) {
        const orderMap = new Map(taskIds.map((id, i) => [id, i]));
        queryClient.setQueryData<AdminProbeTasksResponse>(queryKey, {
          ...prev,
          tasks: [...prev.tasks].sort(
            (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
          ),
        });
      }
      return { prev };
    },
    onError(_err, _vars, ctx) {
      if (ctx?.prev) {
        queryClient.setQueryData(["admin", "probeTasks", query], ctx.prev);
      }
      toast.error(t("probes.reorderFailed"));
    },
    async onSettled() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "probeTasks"] });
    },
  });

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminProbeTask | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);

  const tasks = tasksQuery.data?.tasks ?? [];
  const total = tasksQuery.data?.total ?? 0;
  // Reorder rewrites displayOrder for the visible set; disable drag when filters
  // are active or the slice is truncated, otherwise it would clobber off-screen rows.
  const isTruncated = total > tasks.length;
  const canDrag = !hasFilters && !isTruncated;

  const tableBodyRef = React.useRef<HTMLTableSectionElement>(null);

  const restrictToTableBody = React.useCallback<Modifier>(({ draggingNodeRect, transform }) => {
    const container = tableBodyRef.current?.getBoundingClientRect();
    if (!draggingNodeRect || !container) {
      return { ...transform, x: 0 };
    }
    const minY = container.top - draggingNodeRect.top;
    const maxY = container.bottom - draggingNodeRect.bottom;
    return { ...transform, x: 0, y: Math.min(Math.max(transform.y, minY), maxY) };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = tasks.findIndex((t) => t.id === active.id);
    const newIndex = tasks.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(tasks, oldIndex, newIndex);
    reorder.mutate(reordered.map((t) => t.id));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-xl font-semibold">{t("probes.title")}</div>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>{t("probes.createTask")}</Button>
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
        </div>
      </div>

      {tasksQuery.isError ? (
        <QueryErrorCard
          error={tasksQuery.error}
          retrying={tasksQuery.isFetching}
          onRetry={() => tasksQuery.refetch()}
        />
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="w-full sm:w-60"
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
            <Select
              value={enabled === null ? "" : enabled ? "true" : "false"}
              onValueChange={(v) => {
                if (!v || v === SELECT_ALL_VALUE) return onEnabledChange(null);
                onEnabledChange(v === "true");
              }}
            >
              <SelectTrigger className="w-full sm:w-32">
                <SelectValue placeholder={t("agents.filters.enabled")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_ALL_VALUE}>{t("common.all")}</SelectItem>
                <SelectItem value="true">{t("common.true")}</SelectItem>
                <SelectItem value="false">{t("common.false")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {tasksQuery.isLoading ? (
            <ProbeTasksPageSkeleton />
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={canDrag ? [restrictToTableBody] : undefined}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={tasks.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {/* Mobile compact list */}
                <div className="md:hidden">
                  {tasks.map((tsk) => (
                    <SortableProbeTaskRowCompact
                      key={tsk.id}
                      task={tsk}
                      draggable={canDrag}
                      onEdit={() => {
                        setEditing(tsk);
                        setEditOpen(true);
                      }}
                      onDelete={() => handleDeleteTask(tsk.id)}
                    />
                  ))}
                </div>

                {/* Desktop table */}
                <div className="hidden overflow-x-auto md:block">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8 px-1" />
                        <TableHead className="w-32">{t("probes.table.name")}</TableHead>
                        <TableHead className="w-24">{t("probes.table.kind")}</TableHead>
                        <TableHead className="w-48">{t("probes.table.target")}</TableHead>
                        <TableHead className="w-16">{t("probes.table.interval")}</TableHead>
                        <TableHead className="w-24">{t("probes.form.agents")}</TableHead>
                        <TableHead className="w-20">{t("probes.table.status")}</TableHead>
                        <TableHead className="w-28">{t("probes.table.actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody ref={tableBodyRef}>
                      {tasks.map((tsk) => (
                        <SortableProbeTaskRow
                          key={tsk.id}
                          task={tsk}
                          draggable={canDrag}
                          onEdit={() => {
                            setEditing(tsk);
                            setEditOpen(true);
                          }}
                          onDelete={() => handleDeleteTask(tsk.id)}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </SortableContext>
            </DndContext>
          )}
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
