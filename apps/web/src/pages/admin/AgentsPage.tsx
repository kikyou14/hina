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
import { Link } from "react-router-dom";

import { toast } from "sonner";
import {
  createAdminAgent,
  deleteAdminAgent,
  patchAdminAgent,
  reorderAdminAgents,
} from "@/api/adminAgents";
import type { AdminAgent, AdminAgentsResponse } from "@/api/adminAgents";
import { AdminPagination } from "@/components/AdminPagination";
import { useConfirm } from "@/components/ConfirmDialog";
import { CountryFlag } from "@/components/CountryFlag";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { TagBadge } from "@/components/TagBadge";
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
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useAdminAgents } from "@/queries/adminAgents";
import { invalidateAdminGroups } from "@/queries/adminGroups";
import { AgentDeployDialog } from "./AgentDeployDialog";
import { AgentIpList } from "./components/AgentIpList";
import { CreateAgentForm } from "./components/CreateAgentForm";
import { EditAgentForm } from "./components/EditAgentForm";

function AgentDragHandle({
  activatorRef,
  listeners,
}: {
  activatorRef: (node: HTMLElement | null) => void;
  listeners: ReturnType<typeof useSortable>["listeners"];
}) {
  const { t } = useTranslation();
  const label = t("agents.dragToReorder");
  return (
    <button
      ref={activatorRef}
      {...listeners}
      type="button"
      className="text-muted-foreground hover:text-foreground flex cursor-grab items-center justify-center rounded p-1 active:cursor-grabbing"
      tabIndex={-1}
      aria-label={label}
      title={label}
    >
      <GripVertical className="size-4" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function AgentActions({
  onEdit,
  onDeploy,
  onDelete,
  deleteDisabled,
}: {
  onEdit: () => void;
  onDeploy: () => void;
  onDelete: () => void;
  deleteDisabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={onEdit}>
        {t("common.edit")}
      </Button>
      <Button variant="outline" size="sm" onClick={onDeploy}>
        {t("agents.deploy.button")}
      </Button>
      <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleteDisabled}>
        {t("common.delete")}
      </Button>
    </div>
  );
}

function SortableAgentRowCompact({
  agent: a,
  onEdit,
  onDeploy,
  onDelete,
  deleteDisabled,
  draggable,
}: {
  agent: AdminAgent;
  onEdit: () => void;
  onDeploy: () => void;
  onDelete: () => void;
  deleteDisabled: boolean;
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
  } = useSortable({ id: a.id, disabled: !draggable });

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
          <AgentDragHandle activatorRef={setActivatorNodeRef} listeners={listeners} />
        ) : (
          <div className="w-6" />
        )}
        <span
          className={
            a.status.online
              ? "h-2 w-2 shrink-0 rounded-full bg-emerald-500"
              : "bg-muted-foreground/40 h-2 w-2 shrink-0 rounded-full"
          }
        />
        <CountryFlag code={a.geo.countryCode} className="text-base" />
        <Link
          to={`/agents/${encodeURIComponent(a.id)}`}
          className="min-w-0 truncate font-medium hover:underline"
        >
          {a.name}
        </Link>
        {a.group ? (
          <span className="text-muted-foreground ml-auto shrink-0 text-xs">{a.group}</span>
        ) : null}
      </div>

      <div className="mt-2 pl-8 text-xs">
        <AgentIpList status={a.status} />
      </div>

      {a.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 pl-8">
          {a.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
        </div>
      ) : null}

      <div className="mt-3 pl-8">
        <AgentActions
          onEdit={onEdit}
          onDeploy={onDeploy}
          onDelete={onDelete}
          deleteDisabled={deleteDisabled}
        />
      </div>
    </div>
  );
}

function SortableAgentRow({
  agent: a,
  onEdit,
  onDeploy,
  onDelete,
  deleteDisabled,
  draggable,
}: {
  agent: AdminAgent;
  onEdit: () => void;
  onDeploy: () => void;
  onDelete: () => void;
  deleteDisabled: boolean;
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
  } = useSortable({ id: a.id, disabled: !draggable });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <TableRow ref={setNodeRef} style={style} {...attributes}>
      <TableCell className="w-8 px-1">
        {draggable ? (
          <AgentDragHandle activatorRef={setActivatorNodeRef} listeners={listeners} />
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span
            className={
              a.status.online
                ? "h-2 w-2 rounded-full bg-emerald-500"
                : "bg-muted-foreground/40 h-2 w-2 rounded-full"
            }
          />
          <CountryFlag code={a.geo.countryCode} className="text-base" />
          <Link to={`/agents/${encodeURIComponent(a.id)}`} className="font-medium hover:underline">
            {a.name}
          </Link>
        </div>
      </TableCell>
      <TableCell className="text-xs">
        <AgentIpList status={a.status} />
      </TableCell>
      <TableCell>
        {a.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {a.tags.map((tag) => (
              <TagBadge key={tag} tag={tag} />
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell>{a.group ?? "-"}</TableCell>
      <TableCell>
        <AgentActions
          onEdit={onEdit}
          onDeploy={onDeploy}
          onDelete={onDelete}
          deleteDisabled={deleteDisabled}
        />
      </TableCell>
    </TableRow>
  );
}

export function AgentsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("agents.title"));
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [limit, setLimit] = React.useState(50);
  const [offset, setOffset] = React.useState(0);

  const listQuery = React.useMemo(() => ({ limit, offset }), [limit, offset]);
  const agentsQuery = useAdminAgents(listQuery);

  const invalidateAgents = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "agents"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "options", "agents"] }),
      invalidateAdminGroups(queryClient),
    ]);
  }, [queryClient]);

  const createAgent = useMutation({
    mutationFn: createAdminAgent,
    onSuccess: invalidateAgents,
  });

  const updateAgent = useMutation({
    mutationFn: async (args: { agentId: string; patch: Parameters<typeof patchAdminAgent>[1] }) =>
      patchAdminAgent(args.agentId, args.patch),
    onSuccess: invalidateAgents,
  });

  const deleteAgent = useMutation({
    mutationFn: deleteAdminAgent,
    onSuccess: invalidateAgents,
  });

  const reorder = useMutation({
    mutationFn: reorderAdminAgents,
    async onMutate(agentIds) {
      await queryClient.cancelQueries({ queryKey: ["admin", "agents"] });
      const queryKey = ["admin", "agents", listQuery];
      const prev = queryClient.getQueryData<AdminAgentsResponse>(queryKey);
      if (prev) {
        const orderMap = new Map(agentIds.map((id, i) => [id, i]));
        queryClient.setQueryData<AdminAgentsResponse>(queryKey, {
          ...prev,
          agents: [...prev.agents].sort(
            (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
          ),
        });
      }
      return { prev };
    },
    onError(_err, _vars, ctx) {
      if (ctx?.prev) {
        queryClient.setQueryData(["admin", "agents", listQuery], ctx.prev);
      }
      toast.error(t("agents.reorderFailed"));
    },
    async onSettled() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "agents"] });
    },
  });

  const [createOpen, setCreateOpen] = React.useState(false);

  const [editOpen, setEditOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminAgent | null>(null);

  const [deployTarget, setDeployTarget] = React.useState<{
    agentId: string;
    agentName: string;
    token: string | null;
  } | null>(null);

  const agents = agentsQuery.data?.agents ?? [];
  const total = agentsQuery.data?.total ?? 0;
  // Reorder rewrites displayOrder for the visible set; disable drag when the
  // server returned a truncated slice so it can't clobber off-screen rows.
  const isTruncated = total > agents.length;
  const canDrag = !isTruncated;

  const handleDeleteAgent = (agentId: string) => {
    void confirm({
      title: t("common.confirmDelete"),
      description: t("agents.deleteConfirm"),
      confirmText: t("common.delete"),
      variant: "destructive",
      onConfirm: () => deleteAgent.mutateAsync(agentId),
      errorMessage: t("agents.deleteFailed"),
    });
  };

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

    const oldIndex = agents.findIndex((a) => a.id === active.id);
    const newIndex = agents.findIndex((a) => a.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(agents, oldIndex, newIndex);
    reorder.mutate(reordered.map((a) => a.id));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-xl font-semibold">{t("agents.title")}</div>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>{t("agents.createAgent")}</Button>
          </DialogTrigger>
          <DialogContent scrollBehavior="viewport">
            <DialogHeader>
              <DialogTitle>{t("agents.createDialog.title")}</DialogTitle>
            </DialogHeader>

            <CreateAgentForm
              pending={createAgent.isPending}
              onSubmit={async (v) => {
                const res = await createAgent.mutateAsync(v);
                setCreateOpen(false);
                setDeployTarget({ agentId: res.id, agentName: v.name, token: res.token });
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {agentsQuery.isError ? (
        <QueryErrorCard
          error={agentsQuery.error}
          retrying={agentsQuery.isFetching}
          onRetry={() => agentsQuery.refetch()}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("agents.title")}</CardTitle>
          <CardDescription>
            {agentsQuery.isLoading ? (
              <Skeleton className="inline-block h-4 w-16 align-middle" />
            ) : (
              t("agents.shownTotal", { shown: agents.length, total })
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={canDrag ? [restrictToTableBody] : undefined}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={agents.map((a) => a.id)} strategy={verticalListSortingStrategy}>
              {/* Mobile compact list */}
              <div className="md:hidden">
                {agents.map((a) => (
                  <SortableAgentRowCompact
                    key={a.id}
                    agent={a}
                    draggable={canDrag}
                    onEdit={() => {
                      setEditing(a);
                      setEditOpen(true);
                    }}
                    onDeploy={() => {
                      setDeployTarget({ agentId: a.id, agentName: a.name, token: null });
                    }}
                    onDelete={() => handleDeleteAgent(a.id)}
                    deleteDisabled={deleteAgent.isPending}
                  />
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8 px-1" />
                      <TableHead>{t("agents.table.name")}</TableHead>
                      <TableHead>{t("agents.table.ip")}</TableHead>
                      <TableHead>{t("agents.filters.tags")}</TableHead>
                      <TableHead>{t("agents.table.group")}</TableHead>
                      <TableHead>{t("agents.table.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody ref={tableBodyRef}>
                    {agents.map((a) => (
                      <SortableAgentRow
                        key={a.id}
                        agent={a}
                        draggable={canDrag}
                        onEdit={() => {
                          setEditing(a);
                          setEditOpen(true);
                        }}
                        onDeploy={() => {
                          setDeployTarget({ agentId: a.id, agentName: a.name, token: null });
                        }}
                        onDelete={() => handleDeleteAgent(a.id)}
                        deleteDisabled={deleteAgent.isPending}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SortableContext>
          </DndContext>
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

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg" scrollBehavior="viewport">
          <DialogHeader>
            <DialogTitle>{t("agents.editDialog.title")}</DialogTitle>
          </DialogHeader>
          {editing ? (
            <EditAgentForm
              key={editing.id}
              agent={editing}
              pending={updateAgent.isPending}
              onSave={async (patch) => {
                await updateAgent.mutateAsync({ agentId: editing.id, patch });
              }}
              onClose={() => setEditOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {deployTarget ? (
        <AgentDeployDialog
          key={deployTarget.agentId}
          open
          onOpenChange={(open) => {
            if (!open) setDeployTarget(null);
          }}
          agentId={deployTarget.agentId}
          agentName={deployTarget.agentName}
          token={deployTarget.token}
          onTokenRotated={(token) => setDeployTarget({ ...deployTarget, token })}
        />
      ) : null}
    </div>
  );
}
