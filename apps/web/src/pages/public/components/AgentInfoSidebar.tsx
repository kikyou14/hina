import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Clock,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Layers,
  MemoryStick,
  Monitor,
  Network,
  RefreshCw,
  Terminal,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PublicAgentDetailResponse } from "@/api/public";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { formatBytes } from "@/lib/format";
import { useNowTicker } from "@/hooks/useNowTicker";
import { getMetricNumber } from "@/lib/metrics";
import { formatDurationCompact, getDisplayedUptimeSeconds } from "@/lib/time";
import { normalizeArchLabel } from "../lib/chartHelpers";

function StatRow(props: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
  sub?: string;
}) {
  return (
    <div className="group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted transition-colors group-hover:bg-teal-500/10">
        <span className="text-muted-foreground transition-colors group-hover:text-teal-500">
          {props.icon}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="stat-label mb-0.5">{props.label}</div>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`stat-value truncate ${props.accent ? "text-teal-600 dark:text-teal-400" : ""}`}>
              {props.value}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            {props.value}
          </TooltipContent>
        </Tooltip>
        {props.sub ? <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{props.sub}</div> : null}
      </div>
    </div>
  );
}

function TrafficBar(props: {
  usedBytes: number;
  totalBytes: number;
  overQuota?: boolean;
  label: string;
  overQuotaLabel: string;
}) {
  const pct = props.totalBytes > 0 ? Math.min(100, (props.usedBytes / props.totalBytes) * 100) : 0;
  return (
    <div className="px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="stat-label">{props.label}</span>
        <span className="stat-value text-xs">
          {formatBytes(props.usedBytes)} / {formatBytes(props.totalBytes)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-linear-to-r from-teal-500 to-cyan-500 transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{pct.toFixed(1)}%</span>
        {props.overQuota ? <Badge variant="destructive" className="text-[9px]">{props.overQuotaLabel}</Badge> : null}
      </div>
    </div>
  );
}

function DashedDivider() {
  return <div className="mx-3 my-1 border-t border-dashed border-border" />;
}

export function AgentInfoSidebar(props: {
  agent: PublicAgentDetailResponse | undefined;
}) {
  const { t } = useTranslation();
  const { timezone } = useSiteConfig();
  const { agent } = props;
  const nowMs = useNowTicker();

  const inventory = agent?.inventory ?? null;
  const cpuBrand = inventory?.cpu_brand ?? null;
  const cpuCount = inventory?.cpu_count ?? null;
  const memTotal = inventory?.mem_total_bytes ?? null;
  const diskTotal = inventory?.disk_total_bytes ?? null;
  const gpuList = inventory?.gpus ?? [];

  const displayedUptimeSeconds = agent
    ? getDisplayedUptimeSeconds({
        online: agent.status.online,
        lastSeenAtMs: agent.status.lastSeenAtMs,
        uptimeSec: agent.latest?.uptimeSec,
        nowMs,
      })
    : null;
  const displayedUptime = formatDurationCompact(displayedUptimeSeconds);

  const latestMetrics = agent?.latest?.m ?? null;
  const memUsedBytes = getMetricNumber(latestMetrics, "mem.used_bytes");
  const memTotalBytes = memTotal ?? getMetricNumber(latestMetrics, "mem.total_bytes");
  const diskUsedBytes = getMetricNumber(latestMetrics, "disk.used_bytes");
  const diskTotalBytes = diskTotal ?? getMetricNumber(latestMetrics, "disk.total_bytes");
  const swapUsedBytes = getMetricNumber(latestMetrics, "swap.used_bytes");
  const swapTotalBytes = inventory?.swap_total_bytes ?? getMetricNumber(latestMetrics, "swap.total_bytes");
  const load1 = getMetricNumber(latestMetrics, "load.1");

  const formattedLastReport = agent?.status.lastSeenAtMs
    ? new Date(agent.status.lastSeenAtMs).toLocaleString("en-US", {
        timeZone: timezone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "-";

  return (
    <aside className="w-full shrink-0 xl:w-85">
      <div className="xl:sticky xl:top-20">
        <div className="hina-info-card overflow-hidden rounded-xl border border-border bg-card backdrop-blur-sm">
          <div className="space-y-0.5 p-2">
            <StatRow
              icon={<Cpu className="size-3.5" />}
              label={t("publicAgent.overview.cpu")}
              value={cpuBrand ? `${cpuBrand}${cpuCount !== null ? ` (x${cpuCount})` : ""}` : "-"}
            />
            <StatRow
              icon={<Monitor className="size-3.5" />}
              label={t("publicAgent.overview.gpu")}
              value={
                gpuList.length > 0
                  ? gpuList
                      .map((gpu) => gpu.name ?? gpu.vendor ?? gpu.deviceId ?? t("publicAgent.snapshot.unknownGpu"))
                      .join(", ")
                  : t("publicAgent.overview.none")
              }
            />
            <DashedDivider />
            <StatRow
              icon={<MemoryStick className="size-3.5" />}
              label={t("publicAgent.overview.memory")}
              value={`${formatBytes(memUsedBytes)} / ${formatBytes(memTotalBytes)}`}
            />
            <StatRow
              icon={<HardDrive className="size-3.5" />}
              label={t("publicAgent.overview.disk")}
              value={`${formatBytes(diskUsedBytes)} / ${formatBytes(diskTotalBytes)}`}
            />
            <StatRow
              icon={<Database className="size-3.5" />}
              label={t("publicAgent.overview.swapUsed")}
              value={`${formatBytes(swapUsedBytes)} / ${formatBytes(swapTotalBytes)}`}
            />
            <DashedDivider />
            <StatRow
              icon={<Clock className="size-3.5" />}
              label={t("publicAgent.overview.uptime")}
              value={displayedUptimeSeconds !== null ? displayedUptime : "-"}
              accent
            />
            <StatRow
              icon={<Gauge className="size-3.5" />}
              label={t("publicAgent.snapshot.load1m")}
              value={load1 !== null ? load1.toFixed(2) : "-"}
            />
            <StatRow
              icon={<Layers className="size-3.5" />}
              label={t("publicAgent.overview.arch")}
              value={normalizeArchLabel(agent?.system.arch) ?? "-"}
            />
            <StatRow
              icon={<Box className="size-3.5" />}
              label={t("publicAgent.overview.virtualization")}
              value={inventory?.virtualization ?? "-"}
            />
            <StatRow
              icon={<Terminal className="size-3.5" />}
              label={t("publicAgent.overview.os")}
              value={agent?.system.os ?? "-"}
            />
            <StatRow
              icon={<Network className="size-3.5" />}
              label={t("publicAgent.overview.kernel")}
              value={inventory?.kernel_version ?? "-"}
            />

            {agent?.billing && agent.billing.quotaBytes > 0 ? (
              <>
                <DashedDivider />
                <TrafficBar
                  usedBytes={agent.billing.usedBytes}
                  totalBytes={agent.billing.quotaBytes}
                  overQuota={agent.billing.overQuota}
                  label={t("billing.periodTraffic")}
                  overQuotaLabel={t("billing.overQuota")}
                />
              </>
            ) : null}

            <DashedDivider />
            <div className="flex items-center gap-2 px-3 py-2">
              <RefreshCw className="size-3 text-muted-foreground" />
              <span className="font-mono text-[11px] text-muted-foreground">
                {t("publicAgent.overview.lastReport")}: {formattedLastReport}
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
