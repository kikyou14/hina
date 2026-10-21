import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  createAdminAgent,
  deleteAdminAgent,
  patchAdminAgent,
  reorderAdminAgents,
} from "@/api/adminAgents";
import type { AdminAgent } from "@/api/adminAgents";
import { AdminPagination } from "@/components/AdminPagination";
import { useConfirm } from "@/components/ConfirmDialog";
import { CountryFlag } from "@/components/CountryFlag";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { TagBadge } from "@/components/TagBadge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useNowValue } from "@/hooks/useNowTicker";
import { formatIsoShort, formatTimeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useAdminAgents } from "@/queries/adminAgents";
import { invalidateAdminGroups, useAdminGroups } from "@/queries/adminGroups";
import { AgentDeployDialog } from "./AgentDeployDialog";
import { AdminFilterTabs, AdminList, AdminSearchInput } from "./components/AdminList";
import { AdminPageHeader } from "./components/AdminPageHeader";
import { AgentIpList } from "./components/AgentIpList";
import { CreateAgentForm } from "./components/CreateAgentForm";
import { EditAgentForm } from "./components/EditAgentForm";
import { RowActions } from "./components/RowActions";
import { SortableList, SortableRow } from "./components/SortableList";
import { useReorderMutation } from "./lib/reorder";

// Tracks: handle, agent, IP, tags, status, actions.
const AGENT_GRID = "@2xl/list:grid-cols-[1.5rem_minmax(0,1fr)_9rem_minmax(0,0.8fr)_4.5rem_4.25rem]";

const ALL_GROUPS = "__all__";

const SEARCH_DEBOUNCE_MS = 250;

type StatusFilter = "all" | "online" | "offline";

function AgentIdentity({ agent: a }: { agent: AdminAgent }) {
  const { t } = useTranslation();
  const meta = [
    a.group ?? t("agents.ungrouped"),
    a.system.agentVersion && `v${a.system.agentVersion}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <CountryFlag code={a.geo.countryCode} className="shrink-0 text-base leading-none" />
        <Link
          to={`/agents/${encodeURIComponent(a.id)}`}
          className="truncate text-sm font-medium hover:underline"
          title={a.name}
        >
          {a.name}
        </Link>
        {a.isPublic ? null : (
          <span className="text-muted-foreground shrink-0" title={t("common.private")}>
            <EyeOff className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("common.private")}</span>
          </span>
        )}
      </div>
      <div className="text-muted-foreground mt-0.5 truncate leading-4">{meta}</div>
    </>
  );
}

function AgentStatus({ status }: { status: AdminAgent["status"] }) {
  const { t, i18n } = useTranslation();
  const { timezone } = useSiteConfig();
  const { online, lastSeenAtMs } = status;
  const lastSeen = useNowValue((nowMs) =>
    online || lastSeenAtMs === null ? null : formatTimeAgo(lastSeenAtMs, nowMs, i18n.language),
  );

  return (
    <div className="leading-tight whitespace-nowrap">
      <div
        className={cn(
          "flex items-center gap-1.5",
          online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            online ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        {online ? t("common.online") : t("common.offline")}
      </div>
      {online ? null : (
        <div
          className="text-muted-foreground mt-0.5 pl-3 text-[11px]"
          title={lastSeenAtMs === null ? undefined : formatIsoShort(lastSeenAtMs, timezone)}
        >
          {lastSeen ?? t("agents.neverConnected")}
        </div>
      )}
    </div>
  );
}

export function AgentsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("agents.title"));
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [q, setQ] = React.useState("");
  const [groupId, setGroupId] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [limit, setLimit] = React.useState(50);
  const [offset, setOffset] = React.useState(0);

  // Filter setters reset offset in the same update so no request goes out with
  // a stale offset.
  const onQChange = (v: string) => {
    setQ(v);
    setOffset(0);
  };
  const onGroupChange = (v: string) => {
    setGroupId(v);
    setOffset(0);
  };
  const onStatusChange = (v: StatusFilter) => {
    setStatus(v);
    setOffset(0);
  };
  const clearFilters = () => {
    setQ("");
    setGroupId("");
    setStatus("all");
    setOffset(0);
  };

  // Each search request makes the server sync and re-filter every agent, so
  // wait for typing to pause before querying.
  const searchQ = useDebouncedValue(q.trim(), SEARCH_DEBOUNCE_MS);
  const listQuery = React.useMemo(
    () => ({
      q: searchQ || undefined,
      groupId: groupId || undefined,
      online: status === "all" ? undefined : status === "online",
      limit,
      offset,
    }),
    [searchQ, groupId, status, limit, offset],
  );
  const hasFilters =
    listQuery.q !== undefined || listQuery.groupId !== undefined || listQuery.online !== undefined;

  const agentsQuery = useAdminAgents(listQuery);
  const groups = useAdminGroups().data ?? [];

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

  const reorder = useReorderMutation({
    listKey: ["admin", "agents"],
    queryKey: ["admin", "agents", listQuery],
    field: "agents",
    mutationFn: reorderAdminAgents,
    errorMessage: t("agents.reorderFailed"),
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
  const onlineCount = agents.filter((a) => a.status.online).length;
  // Reorder rewrites displayOrder for the visible set; disable drag when filters
  // are active, the slice is truncated, or the previous query's rows are still
  // shown, otherwise it would clobber rows that aren't on screen.
  const isTruncated = total > agents.length;
  const canDrag = !hasFilters && !isTruncated && !agentsQuery.isPlaceholderData;
  // The online count needs the whole set, and under a status filter it would
  // only ever be all or none of the total.
  const showOnlineCount = !isTruncated && listQuery.online === undefined;

  const statusItems = [
    { value: "all", label: t("common.all") },
    { value: "online", label: t("common.online") },
    { value: "offline", label: t("common.offline") },
  ] as const;

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

  return (
    <div className="space-y-4">
      <AdminPageHeader
        title={t("agents.title")}
        description={
          agentsQuery.isLoading ? (
            <Skeleton className="h-4 w-28" />
          ) : showOnlineCount ? (
            t("agents.summary", { total, online: onlineCount })
          ) : (
            t("agents.summaryTotal", { total })
          )
        }
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus data-icon="inline-start" />
                {t("agents.createAgent")}
              </Button>
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
        }
      />

      {agentsQuery.isError ? (
        <QueryErrorCard
          error={agentsQuery.error}
          retrying={agentsQuery.isFetching}
          onRetry={() => agentsQuery.refetch()}
        />
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <AdminSearchInput
              value={q}
              onChange={(e) => onQChange(e.target.value)}
              placeholder={t("agents.searchPlaceholder")}
            />
            {groups.length > 0 ? (
              <Select
                value={groupId || ALL_GROUPS}
                onValueChange={(v) => onGroupChange(v === ALL_GROUPS ? "" : v)}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label={t("agents.allGroups")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_GROUPS}>{t("agents.allGroups")}</SelectItem>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <AdminFilterTabs value={status} onChange={onStatusChange} items={statusItems} />
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
            grid={AGENT_GRID}
            columns={[
              "",
              t("agents.table.node"),
              t("agents.table.ip"),
              t("agents.filters.tags"),
              t("agents.table.status"),
              "",
            ]}
            count={agents.length}
            loading={agentsQuery.isLoading}
            empty={
              agentsQuery.isError ? null : hasFilters ? t("common.noMatches") : t("agents.empty")
            }
          >
            <SortableList ids={agents.map((a) => a.id)} onReorder={(ids) => reorder.mutate(ids)}>
              {agents.map((a) => (
                <SortableRow
                  key={a.id}
                  id={a.id}
                  draggable={canDrag}
                  grid={AGENT_GRID}
                  primary={<AgentIdentity agent={a} />}
                  cells={[
                    <AgentIpList
                      status={a.status}
                      className="flex-row flex-wrap gap-x-4 @2xl/list:flex-col"
                    />,
                    a.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {a.tags.map((tag) => (
                          <TagBadge key={tag} tag={tag} />
                        ))}
                      </div>
                    ) : null,
                  ]}
                  aside={<AgentStatus status={a.status} />}
                  actions={
                    <RowActions
                      onEdit={() => {
                        setEditing(a);
                        setEditOpen(true);
                      }}
                      menu={[
                        {
                          label: t("agents.deploy.button"),
                          icon: SquareTerminal,
                          onSelect: () =>
                            setDeployTarget({ agentId: a.id, agentName: a.name, token: null }),
                        },
                        {
                          label: t("common.delete"),
                          icon: Trash2,
                          destructive: true,
                          disabled: deleteAgent.isPending,
                          onSelect: () => handleDeleteAgent(a.id),
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
