import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import type { AdminAlertChannel } from "@/api/adminAlerts";
import {
  createAdminAlertChannel,
  deleteAdminAlertChannel,
  patchAdminAlertChannel,
  testAdminAlertChannel,
} from "@/api/adminAlerts";
import { AdminPagination } from "@/components/AdminPagination";
import { useConfirm } from "@/components/ConfirmDialog";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { useSiteConfig } from "@/components/SiteConfigProvider";
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
import { Skeleton } from "@/components/ui/skeleton";
import { formatIsoShort } from "@/lib/time";
import { getUserErrorMessage } from "@/lib/userErrors";
import { useAdminAlertChannels } from "@/queries/adminAlerts";
import { EnabledBadge } from "./components/AdminBadges";
import { AdminList, AdminListRow } from "./components/AdminList";
import { AlertChannelForm } from "./components/AlertChannelForm";
import { ChannelConfigSummary } from "./components/ChannelConfigSummary";
import { RowActions } from "./components/RowActions";

// Tracks: channel, type, updated, status, actions.
const CHANNEL_GRID = "@2xl/list:grid-cols-[minmax(0,1fr)_7rem_7.5rem_4.5rem_4.25rem]";

export function AlertChannelsPanel() {
  const { t } = useTranslation();
  const { timezone } = useSiteConfig();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [limit, setLimit] = React.useState(50);
  const [offset, setOffset] = React.useState(0);
  const channels = useAdminAlertChannels({ limit, offset });

  const invalidateChannels = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "alertChannels"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "options", "alertChannels"] }),
    ]);
  }, [queryClient]);

  const createChannel = useMutation({
    mutationFn: createAdminAlertChannel,
    onSuccess: invalidateChannels,
  });
  const updateChannel = useMutation({
    mutationFn: async (args: {
      channelId: string;
      patch: Parameters<typeof patchAdminAlertChannel>[1];
    }) => patchAdminAlertChannel(args.channelId, args.patch),
    onSuccess: invalidateChannels,
  });
  const removeChannel = useMutation({
    mutationFn: deleteAdminAlertChannel,
    onSuccess: invalidateChannels,
  });
  const testChannel = useMutation({
    mutationFn: testAdminAlertChannel,
  });

  const [createChannelOpen, setCreateChannelOpen] = React.useState(false);
  const [editChannel, setEditChannel] = React.useState<AdminAlertChannel | null>(null);

  const handleDeleteChannel = (channelId: string) => {
    void confirm({
      title: t("common.confirmDelete"),
      description: t("settings.channels.deleteConfirm"),
      confirmText: t("common.delete"),
      variant: "destructive",
      onConfirm: () => removeChannel.mutateAsync(channelId),
      errorMessage: t("settings.channels.deleteFailed"),
    });
  };

  const handleTestChannel = async (channelId: string) => {
    try {
      await testChannel.mutateAsync(channelId);
      toast.success(t("settings.channels.testSent"));
    } catch (err) {
      toast.error(
        getUserErrorMessage(err, t, {
          action: "test",
          fallback: t("settings.channels.testFailed"),
        }),
      );
    }
  };

  const channelList = channels.data?.channels ?? [];

  return (
    <>
      {channels.isError ? (
        <QueryErrorCard
          error={channels.error}
          retrying={channels.isFetching}
          onRetry={() => channels.refetch()}
        />
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="text-muted-foreground">
              {channels.isLoading ? (
                <Skeleton className="h-4 w-16" />
              ) : (
                t("settings.channels.table.count", { count: channels.data?.total ?? 0 })
              )}
            </div>
            <Dialog open={createChannelOpen} onOpenChange={setCreateChannelOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus data-icon="inline-start" />
                  {t("settings.channels.createChannel")}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl" scrollBehavior="viewport">
                <DialogHeader>
                  <DialogTitle>{t("settings.channels.createDialog.title")}</DialogTitle>
                </DialogHeader>
                <AlertChannelForm
                  mode="create"
                  pending={createChannel.isPending}
                  onSubmit={async (v) => {
                    await createChannel.mutateAsync(
                      v as Parameters<typeof createAdminAlertChannel>[0],
                    );
                    setCreateChannelOpen(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          <AdminList
            grid={CHANNEL_GRID}
            columns={[
              t("settings.channels.table.name"),
              t("settings.channels.table.type"),
              t("settings.channels.table.updated"),
              t("settings.channels.table.status"),
              "",
            ]}
            count={channelList.length}
            loading={channels.isLoading}
            empty={channels.isError ? null : t("common.noData")}
          >
            {channelList.map((c) => (
              <AdminListRow
                key={c.id}
                grid={CHANNEL_GRID}
                primary={
                  <>
                    <div className="truncate text-sm font-medium" title={c.name}>
                      {c.name}
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate leading-4">
                      <ChannelConfigSummary type={c.type} config={c.config} />
                    </div>
                  </>
                }
                cells={[
                  <Badge variant="outline">{c.type}</Badge>,
                  <span className="tabular-nums">{formatIsoShort(c.updatedAtMs, timezone)}</span>,
                ]}
                aside={<EnabledBadge enabled={c.enabled} />}
                actions={
                  <RowActions
                    onEdit={() => setEditChannel(c)}
                    menu={[
                      {
                        label: t("common.test"),
                        icon: Send,
                        disabled:
                          !c.enabled || (testChannel.isPending && testChannel.variables === c.id),
                        onSelect: () => void handleTestChannel(c.id),
                      },
                      {
                        label: t("common.delete"),
                        icon: Trash2,
                        destructive: true,
                        disabled: removeChannel.isPending,
                        onSelect: () => handleDeleteChannel(c.id),
                      },
                    ]}
                  />
                }
              />
            ))}
          </AdminList>
          <AdminPagination
            className="mt-4"
            total={channels.data?.total ?? 0}
            limit={limit}
            offset={offset}
            onOffsetChange={setOffset}
            onLimitChange={setLimit}
          />
        </CardContent>
      </Card>

      {editChannel ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditChannel(null);
          }}
        >
          <DialogContent className="max-w-2xl" scrollBehavior="viewport">
            <DialogHeader>
              <DialogTitle>{t("settings.channels.editDialog.title")}</DialogTitle>
            </DialogHeader>
            <AlertChannelForm
              mode="edit"
              channel={editChannel}
              pending={updateChannel.isPending}
              onSubmit={async (patch) => {
                await updateChannel.mutateAsync({
                  channelId: editChannel.id,
                  patch: patch as Parameters<typeof patchAdminAlertChannel>[1],
                });
                setEditChannel(null);
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
