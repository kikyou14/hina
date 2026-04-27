import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Cable, Cpu, HardDrive, House, ListTree, MemoryStick, Network } from "lucide-react";

import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { LoginDialog } from "@/components/LoginDialog";
import { PublicFooter } from "@/components/PublicFooter";
import { PublicHeader } from "@/components/PublicHeader";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { AgentDetailSkeleton } from "./PublicAgentPage.skeleton";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isApiError } from "@/api/http";
import { formatBytes, formatPct, formatRateBytesPerSec, countryCodeToFlagEmoji } from "@/lib/format";
import { getMetricNumber } from "@/lib/metrics";
import { useOptionalAdminMe } from "@/queries/admin";

import { formatCount, formatPctNumber, formatRateBytesPerSecNumber } from "./lib/chartHelpers";
import { useAgentData } from "./hooks/useAgentData";
import { useLiveMetricBuffer } from "./hooks/useLiveMetricBuffer";
import { useProbeData } from "./hooks/useProbeData";
import { MemoMetricAreaChart } from "./components/MetricAreaChart";
import { AgentInfoSidebar } from "./components/AgentInfoSidebar";
import { LatencyCard } from "./components/LatencyCard";
import { TracerouteCard } from "./components/TracerouteCard";

export function PublicAgentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [loginOpen, setLoginOpen] = React.useState(false);
  const { hideTracerouteForGuests } = useSiteConfig();
  const { agentId, agent } = useAgentData();
  useDocumentTitle(agent.data?.name ?? t("publicAgent.agent"));
  const { liveBuffer, liveSeedStatus, getDisplayedRate, liveStatus } = useLiveMetricBuffer(agentId);
  const probe = useProbeData(agentId);
  const me = useOptionalAdminMe();
  const isLoggedIn = Boolean(me.data?.user);
  const showTraceroute = !hideTracerouteForGuests || isLoggedIn;

  React.useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [agentId]);

  const latestMetrics = agent.data?.latest?.m ?? null;
  const cpuPct = getMetricNumber(latestMetrics, "cpu.usage_pct");
  const memUsedBytes = getMetricNumber(latestMetrics, "mem.used_bytes");
  const memTotalBytes = agent.data?.inventory?.mem_total_bytes ?? getMetricNumber(latestMetrics, "mem.total_bytes");
  const diskUsedBytes = getMetricNumber(latestMetrics, "disk.used_bytes");
  const diskTotalBytes = agent.data?.inventory?.disk_total_bytes ?? getMetricNumber(latestMetrics, "disk.total_bytes");
  const procCount = getMetricNumber(latestMetrics, "proc.count");
  const connTcp = getMetricNumber(latestMetrics, "conn.tcp.count");
  const connUdp = getMetricNumber(latestMetrics, "conn.udp.count");

  const displayedRate = getDisplayedRate(Date.now());

  return (
    <div className="hina-public-page min-h-screen bg-background transition-colors duration-300">
      <ConnectionBanner status={liveStatus} />
      <PublicHeader
        className="sticky top-0 z-50 border-border bg-background/80 backdrop-blur-xl"
        containerClassName="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8"
        left={
          <div className="flex items-center gap-3">
            <Button variant="outline" size="icon" className="size-8" asChild>
              <Link to="/">
                <House className="size-4" />
              </Link>
            </Button>
            <div className="flex items-center gap-2.5">
              {agent.data ? (() => {
                const f = countryCodeToFlagEmoji(agent.data.geo.countryCode);
                return f ? <span className="text-lg leading-none">{f}</span> : null;
              })() : null}
              <h1 className="text-base font-semibold tracking-tight">
                {agent.data?.name ?? t("publicAgent.agent")}
              </h1>
              {agent.data ? (
                agent.data.status.online ? (
                  <span className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
                    <span className="mr-1.5 size-1.5 animate-pulse rounded-full bg-emerald-500" />
                    {t("common.online")}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
                    {t("common.offline")}
                  </span>
                )
              ) : null}
              {agent.data && agent.data.isPublic === false ? <Badge variant="outline">{t("common.private")}</Badge> : null}
              {agent.data?.billing?.overQuota ? <Badge variant="destructive">{t("billing.overQuota")}</Badge> : null}
            </div>
          </div>
        }
      />

      <main className="mx-auto max-w-400 px-4 py-6 sm:px-6 lg:px-8">
        {agent.data ? (
        <div className="flex flex-col gap-6 xl:flex-row">
          <AgentInfoSidebar agent={agent.data} />

          <div className="min-w-0 flex-1 space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <MemoMetricAreaChart
                agentId={agentId}
                title={t("publicAgent.cards.cpu")}
                icon={Cpu}
                color="var(--color-chart-3)"
                dataKey="cpuPct"
                currentValue={formatPct(cpuPct)}
                liveBuffer={liveBuffer}
                liveSeedStatus={liveSeedStatus}
                domainMax={100}
                yTickFormatter={formatPctNumber}
              />
              <MemoMetricAreaChart
                agentId={agentId}
                title={t("publicAgent.cards.ram")}
                icon={MemoryStick}
                color="var(--color-chart-1)"
                dataKey="memUsedPct"
                currentValue={
                  memUsedBytes !== null || memTotalBytes !== null
                    ? `${formatBytes(memUsedBytes)} / ${formatBytes(memTotalBytes)}`
                    : "-"
                }
                liveBuffer={liveBuffer}
                liveSeedStatus={liveSeedStatus}
                domainMax={100}
                yTickFormatter={formatPctNumber}
              />
              <MemoMetricAreaChart
                agentId={agentId}
                title={t("publicAgent.cards.disk")}
                icon={HardDrive}
                color="var(--color-chart-4)"
                dataKey="diskUsedPct"
                currentValue={
                  diskUsedBytes !== null || diskTotalBytes !== null
                    ? `${formatBytes(diskUsedBytes)} / ${formatBytes(diskTotalBytes)}`
                    : "-"
                }
                liveBuffer={liveBuffer}
                liveSeedStatus={liveSeedStatus}
                domainMax={100}
                yTickFormatter={formatPctNumber}
              />
              <MemoMetricAreaChart
                agentId={agentId}
                title={t("publicAgent.cards.network")}
                icon={Network}
                color="var(--color-chart-3)"
                color2="var(--color-chart-1)"
                dataKey="txRate"
                dataKey2="rxRate"
                dataKeyLabel={t("publicAgent.cards.upload")}
                dataKey2Label={t("publicAgent.cards.download")}
                currentValue={
                  <>
                    <span className="font-sans">↑ </span>{formatRateBytesPerSec(displayedRate.txRate)}
                    {" "}<span className="font-sans">↓ </span>{formatRateBytesPerSec(displayedRate.rxRate)}
                  </>
                }
                liveBuffer={liveBuffer}
                liveSeedStatus={liveSeedStatus}
                yTickFormatter={formatRateBytesPerSecNumber}
                isNetwork
              />
              <MemoMetricAreaChart
                agentId={agentId}
                title={t("publicAgent.cards.connections")}
                icon={Cable}
                color="var(--color-chart-4)"
                color2="var(--color-chart-2)"
                dataKey="connTcp"
                dataKey2="connUdp"
                dataKeyLabel="TCP"
                dataKey2Label="UDP"
                currentValue={`TCP ${connTcp !== null ? Math.round(connTcp) : "-"} / UDP ${connUdp !== null ? Math.round(connUdp) : "-"}`}
                liveBuffer={liveBuffer}
                liveSeedStatus={liveSeedStatus}
                yTickFormatter={formatCount}
              />
              <MemoMetricAreaChart
                agentId={agentId}
                title={t("publicAgent.cards.processes")}
                icon={ListTree}
                color="var(--color-chart-5)"
                dataKey="procCount"
                currentValue={procCount !== null ? String(Math.round(procCount)) : "-"}
                liveBuffer={liveBuffer}
                liveSeedStatus={liveSeedStatus}
                yTickFormatter={formatCount}
              />
            </div>

            <LatencyCard
              probeLatestLoading={probe.probeLatestLoading}
              probeLatestError={probe.probeLatestError}
              allProbeResults={probe.allProbeResults}
              latencyProbeResults={probe.latencyProbeResults}
              selectedProbeTaskIds={probe.selectedProbeTaskIds}
              setSelectedProbeTaskIds={probe.setSelectedProbeTaskIds}
              latencyWindow={probe.latencyWindow}
              setLatencyWindow={probe.setLatencyWindow}
              latencyChartData={probe.latencyChartData}
              latencyLines={probe.latencyLines}
              latencyXTickFormatter={probe.latencyXTickFormatter}
              latencyStatsByTaskId={probe.latencyStatsByTaskId}
              latencySeriesLoading={probe.latencySeriesLoading}
              firstProbeSeriesError={probe.firstProbeSeriesError}
            />

            {showTraceroute ? (
              <TracerouteCard
                traceProbeResults={probe.traceProbeResults}
                selectedTraceTaskId={probe.selectedTraceTaskId}
                setSelectedTraceTaskId={probe.setSelectedTraceTaskId}
                traceLatest={probe.traceLatest}
                traceExtra={probe.traceExtra}
                canRenderTrace={probe.canRenderTrace}
                rawTraceText={probe.rawTraceText}
              />
            ) : null}
          </div>
        </div>
        ) : agent.isError ? (
          isApiError(agent.error) && agent.error.status === 404 && !isLoggedIn ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("publicAgent.notFoundOrPrivate.title")}</CardTitle>
                <CardDescription>{t("publicAgent.notFoundOrPrivate.description")}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setLoginOpen(true)}>
                  {t("publicAgent.notFoundOrPrivate.signIn")}
                </Button>
                <Button variant="ghost" asChild>
                  <Link to="/">{t("publicAgent.notFoundOrPrivate.goHome")}</Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <QueryErrorCard
              error={agent.error}
              retrying={agent.isFetching}
              onRetry={() => agent.refetch()}
            />
          )
        ) : (
          <AgentDetailSkeleton />
        )}
      </main>
      <PublicFooter />
      <LoginDialog
        open={loginOpen}
        onOpenChange={setLoginOpen}
        onSuccess={() => navigate("/admin")}
      />
    </div>
  );
}
