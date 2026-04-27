import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import { refreshAsnDb } from "@/api/adminSystem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAsnDbStatus } from "@/queries/adminSystem";

function formatAge(
  ms: number | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (ms === null) return t("settings.general.asnDb.noFile");
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return t("settings.general.asnDb.ageDays", { days, hours });
  if (hours > 0) return t("settings.general.asnDb.ageHours", { hours });
  return t("settings.general.asnDb.ageFresh");
}

export function AsnDbPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useAsnDbStatus();

  const doRefresh = useMutation({
    mutationFn: refreshAsnDb,
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "asnDbStatus"] });
      toast.success(t("settings.general.asnDb.refreshed"));
    },
    onError() {
      toast.error(t("settings.general.asnDb.refreshFailed"));
    },
  });

  const data = status.data;
  const pending = doRefresh.isPending || (data?.refreshing ?? false);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label>{t("settings.general.asnDb.label")}</Label>
        <div className="flex items-center gap-3">
          <Badge variant={data?.loaded ? "default" : "secondary"}>
            {data?.loaded
              ? t("settings.general.asnDb.statusLoaded")
              : t("settings.general.asnDb.statusNotLoaded")}
          </Badge>
          {data ? (
            <span className="text-muted-foreground text-sm">{formatAge(data.fileAgeMs, t)}</span>
          ) : null}
        </div>
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => doRefresh.mutate()}
        >
          {pending ? t("settings.general.asnDb.refreshing") : t("settings.general.asnDb.refresh")}
        </Button>
      </div>
    </div>
  );
}
