import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import { patchAdminSiteConfig } from "@/api/adminSiteConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminSiteConfig } from "@/queries/adminSiteConfig";

export function PublicBaseUrlInput() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const siteConfig = useAdminSiteConfig();

  const saved = siteConfig.data?.current.publicBaseUrl ?? "";
  const [value, setValue] = React.useState(saved);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (!dirty) setValue(saved);
  }, [saved, dirty]);

  const mutation = useMutation({
    mutationFn: patchAdminSiteConfig,
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "siteConfig"] });
      setDirty(false);
    },
  });

  const handleSave = async () => {
    try {
      await mutation.mutateAsync({ publicBaseUrl: value });
      toast.success(t("settings.site.saved"));
    } catch {
      toast.error(t("settings.general.publicBaseUrl.saveFailed"));
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="public-base-url">{t("settings.general.publicBaseUrl.label")}</Label>
      <div className="flex gap-2">
        <Input
          id="public-base-url"
          type="url"
          placeholder="https://hina.example.com"
          value={value}
          disabled={mutation.isPending || !siteConfig.data}
          onChange={(e) => {
            setValue(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) void handleSave();
          }}
        />
        <Button size="sm" disabled={!dirty || mutation.isPending} onClick={() => void handleSave()}>
          {t("common.save")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("settings.general.publicBaseUrl.description")}
      </p>
    </div>
  );
}
