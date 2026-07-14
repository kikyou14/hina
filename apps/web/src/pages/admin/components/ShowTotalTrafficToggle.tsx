import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import { patchAdminSiteConfig } from "@/api/adminSiteConfig";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAdminSiteConfig } from "@/queries/adminSiteConfig";

export function ShowTotalTrafficToggle() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const siteConfig = useAdminSiteConfig();

  const mutation = useMutation({
    mutationFn: patchAdminSiteConfig,
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "siteConfig"] });
      await queryClient.invalidateQueries({ queryKey: ["public", "siteConfig"] });
    },
  });

  const current = siteConfig.data?.current.showTotalTraffic ?? false;
  const pending = mutation.isPending;

  return (
    <div className="flex items-center gap-3">
      <Switch
        id="show-total-traffic"
        checked={current}
        disabled={pending || !siteConfig.data}
        onCheckedChange={async (checked) => {
          try {
            await mutation.mutateAsync({ showTotalTraffic: checked });
            toast.success(t("settings.site.saved"));
          } catch {
            toast.error(t("settings.general.showTotalTraffic.saveFailed"));
          }
        }}
      />
      <Label htmlFor="show-total-traffic">{t("settings.general.showTotalTraffic.label")}</Label>
    </div>
  );
}
