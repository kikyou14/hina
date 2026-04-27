import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { getUserErrorMessage } from "@/lib/userErrors";
import { useAdminAlertChannels } from "@/queries/adminAlerts";
import { AlertChannelForm } from "./components/AlertChannelForm";
import { ChannelConfigSummary } from "./components/ChannelConfigSummary";

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
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>{t("settings.channels.table.title")}</CardTitle>
              <CardDescription>
                {channels.isLoading ? (
                  <Skeleton className="inline-block h-4 w-16 align-middle" />
                ) : (
                  t("settings.channels.table.count", {
                    count: channels.data?.total ?? 0,
                  })
                )}
              </CardDescription>
            </div>
            <Dialog open={createChannelOpen} onOpenChange={setCreateChannelOpen}>
              <DialogTrigger asChild>
                <Button>{t("settings.channels.createChannel")}</Button>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.channels.table.name")}</TableHead>
                <TableHead>{t("settings.channels.table.type")}</TableHead>
                <TableHead>{t("settings.channels.table.status")}</TableHead>
                <TableHead>{t("settings.channels.table.config")}</TableHead>
                <TableHead>{t("settings.channels.table.updated")}</TableHead>
                <TableHead>{t("settings.channels.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(channels.data?.channels ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.type}</Badge>
                  </TableCell>
                  <TableCell>
                    {c.enabled ? (
                      <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">
                        {t("common.enabled")}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">{t("common.disabled")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <ChannelConfigSummary type={c.type} config={c.config} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatIsoShort(c.updatedAtMs, timezone)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            await testChannel.mutateAsync(c.id);
                            toast.success(t("settings.channels.testSent"));
                          } catch (err) {
                            toast.error(
                              getUserErrorMessage(err, t, {
                                action: "test",
                                fallback: t("settings.channels.testFailed"),
                              }),
                            );
                          }
                        }}
                        disabled={
                          !c.enabled || (testChannel.isPending && testChannel.variables === c.id)
                        }
                      >
                        {t("common.test")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setEditChannel(c)}>
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteChannel(c.id)}
                        disabled={removeChannel.isPending}
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
