import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import { patchAdminSiteConfig } from "@/api/adminSiteConfig";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAdminSiteConfig } from "@/queries/adminSiteConfig";
import { useLatestVersion } from "@/queries/version";

export function VersionPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const siteConfig = useAdminSiteConfig();
  const { current, latest, hasUpdate, releaseUrl } = useLatestVersion();

  const mutation = useMutation({
    mutationFn: patchAdminSiteConfig,
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "siteConfig"] });
      await queryClient.invalidateQueries({ queryKey: ["public", "siteConfig"] });
    },
  });

  const versionCheckEnabled = siteConfig.data?.current.versionCheckEnabled ?? true;
  const pending = mutation.isPending;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <Label>{t("settings.general.versionCheck.currentVersion")}</Label>
        <div className="text-muted-foreground text-sm">
          <span>v{current}</span>
          {hasUpdate && releaseUrl ? (
            <>
              <span className="mx-1.5">&rarr;</span>
              <a
                href={releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground inline-flex items-center gap-1 hover:underline"
              >
                v{latest!.replace(/^v/, "")}
                <ExternalLink className="size-3" />
              </a>
            </>
          ) : versionCheckEnabled && latest !== null ? (
            <span className="ml-2 opacity-70">{t("settings.general.versionCheck.upToDate")}</span>
          ) : null}
        </div>
      </div>
      <div className="grid gap-1">
        <div className="flex items-center gap-3">
          <Switch
            id="version-check-enabled"
            checked={versionCheckEnabled}
            disabled={pending || !siteConfig.data}
            onCheckedChange={async (checked) => {
              try {
                await mutation.mutateAsync({ versionCheckEnabled: checked });
                toast.success(t("settings.site.saved"));
              } catch {
                toast.error(t("settings.general.versionCheck.saveFailed"));
              }
            }}
          />
          <Label htmlFor="version-check-enabled">
            {t("settings.general.versionCheck.autoCheck")}
          </Label>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("settings.general.versionCheck.autoCheckDescription")}
        </p>
      </div>
    </div>
  );
}
