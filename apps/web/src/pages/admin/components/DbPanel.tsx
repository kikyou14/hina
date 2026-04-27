import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import { createDbBackup, optimizeDb, startBackupDownload, vacuumDb } from "@/api/adminSystem";
import { isApiError } from "@/api/http";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/format";
import { useDbStatus } from "@/queries/adminSystem";

export function DbPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const status = useDbStatus();

  const doBackup = useMutation({
    mutationFn: createDbBackup,
    onSuccess(data) {
      startBackupDownload(data.token);
    },
    onError(err) {
      const key =
        isApiError(err) && err.code === "backup_already_pending"
          ? "settings.general.db.backupAlreadyPending"
          : "settings.general.db.backupFailed";
      toast.error(t(key));
    },
  });

  const doVacuum = useMutation({
    mutationFn: vacuumDb,
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "dbStatus"] });
      toast.success(t("settings.general.db.vacuumed"));
    },
    onError(err) {
      const detail = isApiError(err) ? (err.details as Record<string, unknown>)?.error : undefined;
      toast.error(typeof detail === "string" ? detail : t("settings.general.db.vacuumFailed"));
    },
  });

  const doOptimize = useMutation({
    mutationFn: optimizeDb,
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "dbStatus"] });
      toast.success(t("settings.general.db.optimized"));
    },
    onError(err) {
      const detail = isApiError(err) ? (err.details as Record<string, unknown>)?.error : undefined;
      toast.error(typeof detail === "string" ? detail : t("settings.general.db.optimizeFailed"));
    },
  });

  const data = status.data;

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label>{t("settings.general.db.label")}</Label>
        {data ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>
              {t("settings.general.db.dbSize")}: {formatBytes(data.dbSizeBytes)}
            </span>
            <span>
              {t("settings.general.db.walSize")}: {formatBytes(data.walSizeBytes)}
            </span>
            {data.freelistCount > 0 && (
              <span>{t("settings.general.db.freelistPages", { count: data.freelistCount })}</span>
            )}
          </div>
        ) : (
          <Skeleton className="h-5 w-48" />
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={doBackup.isPending}
          onClick={() => doBackup.mutate()}
        >
          {doBackup.isPending
            ? t("settings.general.db.backingUp")
            : t("settings.general.db.backup")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={doOptimize.isPending}
          onClick={() => doOptimize.mutate()}
        >
          {doOptimize.isPending
            ? t("settings.general.db.optimizing")
            : t("settings.general.db.optimize")}
        </Button>

        <Button
          type="button"
          variant="outline"
          disabled={doVacuum.isPending}
          onClick={() =>
            void confirm({
              title: t("settings.general.db.vacuumConfirmTitle"),
              description: t("settings.general.db.vacuumConfirmDesc"),
              onConfirm: () => {
                doVacuum.mutate();
              },
            })
          }
        >
          {doVacuum.isPending
            ? t("settings.general.db.vacuuming")
            : t("settings.general.db.vacuum")}
        </Button>
      </div>
    </div>
  );
}
