import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import { patchAdminSiteConfig } from "@/api/adminSiteConfig";
import { patchAdminRuntimeConfig } from "@/api/adminSystem";
import { AnimatedTabsList } from "@/components/AnimatedTabsList";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { getUserErrorMessage } from "@/lib/userErrors";
import { LogsPanel } from "@/pages/admin/LogsPanel";
import { useAdminSiteConfig } from "@/queries/adminSiteConfig";
import { useAdminRuntimeConfig } from "@/queries/adminSystem";
import { AsnDbPanel } from "./components/AsnDbPanel";
import { DbPanel } from "./components/DbPanel";
import { HideTracerouteToggle } from "./components/HideTracerouteToggle";
import { PublicBaseUrlInput } from "./components/PublicBaseUrlInput";
import { RuntimeAgentConfigForm } from "./components/RuntimeAgentConfigForm";
import { SiteConfigForm } from "./components/SiteConfigForm";
import { SortOfflineToggle } from "./components/SortOfflineToggle";
import { VersionPanel } from "./components/VersionPanel";
import { RuntimeConfigFormSkeleton, SiteConfigFormSkeleton } from "./SettingsPage.skeleton";

export function SettingsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("settings.title"));
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState("general");

  const runtimeConfig = useAdminRuntimeConfig();
  const siteConfig = useAdminSiteConfig();

  const updateRuntimeConfig = useMutation({
    mutationFn: patchAdminRuntimeConfig,
    async onSuccess() {
      await queryClient.invalidateQueries({
        queryKey: ["admin", "runtimeConfig"],
      });
    },
  });

  const updateSiteConfig = useMutation({
    mutationFn: patchAdminSiteConfig,
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ["admin", "siteConfig"] });
      await queryClient.invalidateQueries({ queryKey: ["public", "siteConfig"] });
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xl font-semibold">{t("settings.title")}</div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <AnimatedTabsList
          items={[
            { value: "general", label: t("settings.tabs.general") },
            { value: "site", label: t("settings.tabs.site") },
            { value: "runtime", label: t("settings.tabs.runtime") },
            { value: "logs", label: t("settings.tabs.logs") },
          ]}
          value={tab}
        />

        <TabsContent value="site" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.site.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              {siteConfig.isError ? (
                <div className="text-destructive text-sm" role="alert">
                  {getUserErrorMessage(siteConfig.error, t, { action: "load" })}
                </div>
              ) : siteConfig.data ? (
                <SiteConfigForm
                  current={siteConfig.data.current}
                  defaults={siteConfig.data.defaults}
                  pending={updateSiteConfig.isPending}
                  onSubmit={async (patch) => {
                    await updateSiteConfig.mutateAsync(patch);
                    toast.success(t("settings.site.saved"));
                  }}
                />
              ) : (
                <SiteConfigFormSkeleton />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runtime" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.runtime.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              {runtimeConfig.isError ? (
                <div className="text-destructive text-sm" role="alert">
                  {getUserErrorMessage(runtimeConfig.error, t, { action: "load" })}
                </div>
              ) : runtimeConfig.data ? (
                <RuntimeAgentConfigForm
                  current={runtimeConfig.data.current}
                  defaults={runtimeConfig.data.defaults}
                  source={runtimeConfig.data.source}
                  pending={updateRuntimeConfig.isPending}
                  onSubmit={async (patch) => {
                    const res = await updateRuntimeConfig.mutateAsync(patch);
                    toast.success(t("settings.runtime.savedPushed", { count: res.pushed }));
                  }}
                />
              ) : (
                <RuntimeConfigFormSkeleton />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.general.siteConfig.title")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6">
              <PublicBaseUrlInput />
              <SortOfflineToggle />
              <HideTracerouteToggle />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("settings.general.database.title")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6">
              <AsnDbPanel />
              <Separator />
              <DbPanel />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("settings.general.versionCheck.label")}</CardTitle>
            </CardHeader>
            <CardContent>
              <VersionPanel />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <LogsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
