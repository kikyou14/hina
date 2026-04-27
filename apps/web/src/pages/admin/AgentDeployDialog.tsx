import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";
import { rotateAdminAgentToken } from "@/api/adminAgents";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getUserErrorMessage } from "@/lib/userErrors";

const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/kikyou14/hina/main/scripts/install-agent.sh";

function deriveServerUrl(): string {
  const url = new URL(window.location.href);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function buildInstallCommand(opts: {
  token: string;
  serverUrl: string;
  iface: string;
  mountPoints: string;
  downloadProxy: string;
  serviceName: string;
  installDir: string;
}): string {
  // Ensure proxy ends with '/' so the URL concatenation is correct
  const rawProxy = opts.downloadProxy.trim();
  const proxy = rawProxy && !rawProxy.endsWith("/") ? `${rawProxy}/` : rawProxy;
  const scriptUrl = proxy ? `${shellEscape(proxy)}${INSTALL_SCRIPT_URL}` : INSTALL_SCRIPT_URL;

  const envParts: string[] = [
    `SERVER_URL='${shellEscape(opts.serverUrl)}'`,
    `TOKEN='${shellEscape(opts.token)}'`,
  ];

  if (opts.iface.trim()) {
    envParts.push(`INTERFACE='${shellEscape(opts.iface.trim())}'`);
  }
  if (opts.mountPoints.trim()) {
    envParts.push(`MOUNT_POINTS='${shellEscape(opts.mountPoints.trim())}'`);
  }
  if (proxy) {
    envParts.push(`DOWNLOAD_PROXY='${shellEscape(proxy)}'`);
  }
  if (opts.serviceName.trim() && opts.serviceName.trim() !== "hina-agent") {
    envParts.push(`SERVICE_NAME='${shellEscape(opts.serviceName.trim())}'`);
  }
  if (opts.installDir.trim() && opts.installDir.trim() !== "/usr/local/bin") {
    envParts.push(`INSTALL_DIR='${shellEscape(opts.installDir.trim())}'`);
  }

  const envBlock = envParts.map((e) => `  ${e}`).join(" \\\n");
  return `curl -fsSL '${scriptUrl}' | \\\n${envBlock} \\\n  sudo -E bash`;
}

export function AgentDeployDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  token: string | null;
  onTokenRotated: (token: string) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [token, setToken] = React.useState(props.token);
  const [serverUrl, setServerUrl] = React.useState(deriveServerUrl);
  const [iface, setIface] = React.useState("");
  const [mountPoints, setMountPoints] = React.useState("");
  const [downloadProxy, setDownloadProxy] = React.useState("");
  const [serviceName, setServiceName] = React.useState("hina-agent");
  const [installDir, setInstallDir] = React.useState("/usr/local/bin");

  const rotateToken = useMutation({
    mutationFn: () => rotateAdminAgentToken(props.agentId),
    onSuccess(data) {
      setToken(data.token);
      props.onTokenRotated(data.token);
    },
    onError(err) {
      toast.error(getUserErrorMessage(err, t, { action: "update", fallback: t("common.error") }));
    },
  });

  const installCommand = React.useMemo(() => {
    if (!token) return null;
    return buildInstallCommand({
      token,
      serverUrl,
      iface,
      mountPoints,
      downloadProxy,
      serviceName,
      installDir,
    });
  }, [token, serverUrl, iface, mountPoints, downloadProxy, serviceName, installDir]);

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl" scrollBehavior="viewport">
        <DialogHeader>
          <DialogTitle>{t("agents.deploy.title", { name: props.agentName })}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-6">
          {/* Token section */}
          <section className="grid gap-2">
            <Label className="text-sm font-semibold">{t("agents.deploy.token")}</Label>
            {token ? (
              <div className="bg-muted rounded-md border p-3 font-mono text-sm break-all">
                {token}
              </div>
            ) : (
              <div className="text-muted-foreground text-sm">
                {t("agents.deploy.tokenUnavailable")}
              </div>
            )}
            <div className="flex items-center gap-2">
              {token ? (
                <Button variant="outline" size="sm" onClick={() => copyText(token)}>
                  {t("common.copy")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={rotateToken.isPending}
                onClick={() => {
                  void confirm({
                    title: t("agents.rotateToken"),
                    description: t("agents.rotateConfirm"),
                    confirmText: t("agents.rotateToken"),
                    variant: "destructive",
                    onConfirm: () => rotateToken.mutateAsync(),
                  });
                }}
              >
                {rotateToken.isPending ? t("common.loading") : t("agents.rotateToken")}
              </Button>
            </div>
          </section>

          {/* Agent options */}
          <section className="grid gap-3">
            <Label className="text-sm font-semibold">{t("agents.deploy.agentOptions")}</Label>
            <div className="grid gap-2">
              <Label className="text-muted-foreground text-xs">
                {t("agents.deploy.serverUrl")}
              </Label>
              <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground text-xs">
                  {t("agents.deploy.interface")}
                </Label>
                <Input
                  value={iface}
                  onChange={(e) => setIface(e.target.value)}
                  placeholder={t("agents.deploy.interfacePlaceholder")}
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground text-xs">
                  {t("agents.deploy.mountPoints")}
                </Label>
                <Input
                  value={mountPoints}
                  onChange={(e) => setMountPoints(e.target.value)}
                  placeholder={t("agents.deploy.mountPointsPlaceholder")}
                />
              </div>
            </div>
          </section>

          {/* Install options */}
          <section className="grid gap-3">
            <Label className="text-sm font-semibold">{t("agents.deploy.installOptions")}</Label>
            <div className="grid gap-2">
              <Label className="text-muted-foreground text-xs">
                {t("agents.deploy.downloadProxy")}
              </Label>
              <Input
                value={downloadProxy}
                onChange={(e) => setDownloadProxy(e.target.value)}
                placeholder={t("agents.deploy.downloadProxyPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground text-xs">
                  {t("agents.deploy.serviceName")}
                </Label>
                <Input value={serviceName} onChange={(e) => setServiceName(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground text-xs">
                  {t("agents.deploy.installDir")}
                </Label>
                <Input value={installDir} onChange={(e) => setInstallDir(e.target.value)} />
              </div>
            </div>
          </section>

          {/* Install command */}
          <section className="grid gap-2">
            <Label className="text-sm font-semibold">{t("agents.deploy.installCommand")}</Label>
            {installCommand ? (
              <>
                <pre className="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs break-all whitespace-pre-wrap">
                  {installCommand}
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => copyText(installCommand)}
                >
                  {t("agents.deploy.copyCommand")}
                </Button>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">{t("agents.deploy.noTokenHint")}</p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
