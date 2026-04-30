import * as React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Timer01Icon, Calendar } from "@hugeicons/core-free-icons";

import type { PublicAgentSummary } from "@/api/public";
import { CountryFlag } from "@/components/CountryFlag";
import { CyclingText } from "@/components/CyclingText";
import { OsIcon } from "@/components/OsIcon";
import { TagBadge } from "@/components/TagBadge";
import { ResourceBar, MiniBar } from "@/components/ResourceBar";
import { formatBytes, formatRateBytesPerSec, formatOsShort } from "@/lib/format";
import {
  computeStaticAgentMetrics,
  computeAgentUptime,
  computeAgentUptimeDays,
  computeAgentExpiryKey,
  getAgentExpiryDays,
  computeDaysUntilReset,
} from "@/lib/agentMetrics";
import { useNowValue } from "@/hooks/useNowTicker";

const TRAFFIC_CYCLE_INTERVAL_MS = 4000;

let chunkPreloaded = false;
export function preloadAgentPageChunk() {
  if (chunkPreloaded) return;
  chunkPreloaded = true;
  import("@/pages/public/PublicAgentPage");
}

function PricingBadge({ label, prefix }: { label: string; prefix?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
      {prefix ? `${prefix}: ${label}` : label}
    </span>
  );
}

const AGENT_LIST_GRID_CLASS =
  "grid grid-cols-[minmax(9rem,1.1fr)_minmax(16rem,1.6fr)_minmax(6.5rem,0.7fr)_minmax(5rem,0.55fr)_minmax(6rem,0.65fr)_minmax(8rem,1fr)] items-center gap-3";

const AgentUptime = React.memo(function AgentUptime({ a }: { a: PublicAgentSummary }) {
  const uptime = useNowValue((nowMs) => computeAgentUptime(a, nowMs));
  return <>{uptime}</>;
});

const AgentUptimeDays = React.memo(function AgentUptimeDays({ a }: { a: PublicAgentSummary }) {
  const { t } = useTranslation();
  const days = useNowValue((nowMs) => computeAgentUptimeDays(a, nowMs));
  return <>{t("publicAgents.card.uptimeDays", { days })}</>;
});

const AgentExpiryInfo = React.memo(function AgentExpiryInfo({
  a,
  inline,
}: {
  a: PublicAgentSummary;
  inline: boolean;
}) {
  const { t } = useTranslation();
  const expiryKey = useNowValue((nowMs) => computeAgentExpiryKey(a, nowMs));

  if (expiryKey === "expired") {
    const className = "font-medium text-red-500";
    return inline ? (
      <span className={className}>{t("publicAgents.card.expired")}</span>
    ) : (
      <div className={className}>{t("publicAgents.card.expired")}</div>
    );
  }
  const expiryDays = getAgentExpiryDays(expiryKey);
  if (expiryDays === null) return null;

  const label =
    expiryDays === 0
      ? t("publicAgents.card.expiresToday")
      : t("publicAgents.card.expiresIn", { days: expiryDays });

  if (inline) {
    return (
      <span className="inline-flex items-center gap-1">
        <HugeiconsIcon icon={Calendar} strokeWidth={2} className="size-3" />
        {label}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <HugeiconsIcon icon={Calendar} strokeWidth={2} className="size-3" />
      {label}
    </div>
  );
});

const AgentTrafficCell = React.memo(function AgentTrafficCell({
  a,
  trafficValue,
}: {
  a: PublicAgentSummary;
  trafficValue: string;
}) {
  const billing = a.billing;
  if (!billing || billing.quotaBytes <= 0) return <>{trafficValue}</>;
  return <AgentTrafficCycling trafficValue={trafficValue} billing={billing} />;
});

const AgentTrafficCycling = React.memo(function AgentTrafficCycling({
  trafficValue,
  billing,
}: {
  trafficValue: string;
  billing: NonNullable<PublicAgentSummary["billing"]>;
}) {
  const { t } = useTranslation();

  const { txBytes, rxBytes, resetDay } = billing;
  const mountMsRef = React.useRef<number | null>(null);
  const trafficState = useNowValue(
    (nowMs) => {
      mountMsRef.current ??= nowMs;
      return {
        index: Math.floor((nowMs - mountMsRef.current) / TRAFFIC_CYCLE_INTERVAL_MS),
        daysUntilReset: computeDaysUntilReset(resetDay, nowMs),
      };
    },
    (a, b) => a.index === b.index && a.daysUntilReset === b.daysUntilReset,
  );

  const variants = React.useMemo<React.ReactNode[]>(() => {
    const items: React.ReactNode[] = [
      trafficValue,
      <>
        ↑ {formatBytes(txBytes)} ↓ {formatBytes(rxBytes)}
      </>,
    ];
    if (trafficState.daysUntilReset !== null) {
      items.push(t("publicAgents.card.resetIn", { days: trafficState.daysUntilReset }));
    }
    return items;
  }, [trafficValue, txBytes, rxBytes, trafficState.daysUntilReset, t]);

  return <CyclingText items={variants} index={trafficState.index} />;
});

export const AgentCard = React.memo(function AgentCard({ a }: { a: PublicAgentSummary }) {
  const { t } = useTranslation();
  const s = computeStaticAgentMetrics(a);
  const tags = a.tags;

  return (
    <div className="hina-agent-card flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-accent/5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CountryFlag code={s.countryCode} className="text-base" />
          <Link
            className="truncate font-semibold leading-tight hover:underline"
            to={`/agents/${a.id}`}
          >
            {a.name}
          </Link>
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${a.status.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <OsIcon os={a.system.os} className="size-3" />
          {formatOsShort(a.system.os)}
        </div>
      </div>

      <div className="space-y-2.5">
        <ResourceBar
          label="CPU"
          value={s.cpuPct !== null ? `${s.cpuPct.toFixed(0)}%` : "-"}
          pct={s.cpuPct}
        />
        <ResourceBar label={t("publicAgents.card.ram")} value={s.memValue} pct={s.memPct} />
        <ResourceBar label={t("publicAgents.card.disk")} value={s.diskValue} pct={s.diskPct} />
        <ResourceBar
          label={t("publicAgents.card.traffic")}
          value={<AgentTrafficCell a={a} trafficValue={s.trafficValue} />}
          pct={s.trafficPct}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
        <span><span className="font-sans">↑ </span>{formatRateBytesPerSec(s.txRate)}</span>
        <span><span className="font-sans">↓ </span>{formatRateBytesPerSec(s.rxRate)}</span>
        <span className="inline-flex items-center gap-1">
          <HugeiconsIcon icon={Timer01Icon} strokeWidth={2} className="size-3" />
          <AgentUptimeDays a={a} />
        </span>
        <AgentExpiryInfo a={a} inline />
      </div>

      {(s.pricingLabel || tags.length > 0) ? (
        <div className="mt-3 border-t pt-2">
          <div className="flex flex-wrap gap-1">
            {s.pricingLabel ? <PricingBadge label={s.pricingLabel} /> : null}
            {tags.map((tag) => (
              <TagBadge key={tag} tag={tag} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});

export const AgentListRow = React.memo(function AgentListRow({ a }: { a: PublicAgentSummary }) {
  const { t } = useTranslation();
  const s = computeStaticAgentMetrics(a);

  const subtitle = formatOsShort(a.system.os);

  return (
    <div
      className={`${AGENT_LIST_GRID_CLASS} hina-agent-list-row border-b px-4 py-2.5 transition-colors hover:bg-accent/5`}
    >
      <div className="min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0">
          <CountryFlag code={s.countryCode} className="text-sm" />
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${a.status.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
          />
          <Link
            className="truncate text-sm font-semibold leading-tight hover:underline"
            to={`/agents/${a.id}`}
          >
            {a.name}
          </Link>
        </div>
        {subtitle ? (
          <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <OsIcon os={a.system.os} className="size-3 shrink-0" />
            {subtitle}
          </div>
        ) : null}
      </div>

      <div className="grid min-w-0 grid-cols-4 gap-3">
        <MiniBar label="CPU" pct={s.cpuPct} showLabel={false} />
        <MiniBar label={t("publicAgents.card.ram")} pct={s.memPct} showLabel={false} />
        <MiniBar label={t("publicAgents.card.disk")} pct={s.diskPct} showLabel={false} />
        <MiniBar label={t("publicAgents.card.traffic")} pct={s.trafficPct} showLabel={false} />
      </div>

      <div className="min-w-0 font-mono text-xs text-muted-foreground">
        <div><span className="font-sans">↑ </span>{formatRateBytesPerSec(s.txRate)}</div>
        <div><span className="font-sans">↓ </span>{formatRateBytesPerSec(s.rxRate)}</div>
      </div>

      <div className="min-w-0 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <HugeiconsIcon icon={Timer01Icon} strokeWidth={2} className="size-3" />
          <AgentUptime a={a} />
        </div>
      </div>

      <div className="min-w-0 text-xs text-muted-foreground">
        <AgentExpiryInfo a={a} inline={false} />
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {s.pricingLabel ? (
          <PricingBadge label={s.pricingLabel} prefix={t("publicAgents.card.price")} />
        ) : null}
        {a.tags.map((tag) => (
          <TagBadge key={tag} tag={tag} />
        ))}
      </div>
    </div>
  );
});

export function AgentListHeader() {
  const { t } = useTranslation();
  return (
    <div
      className={`${AGENT_LIST_GRID_CLASS} hina-list-header sticky top-0 z-10 border-b bg-muted/70 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur`}
    >
      <div className="min-w-0">{t("publicAgents.table.name")}</div>
      <div className="grid min-w-0 grid-cols-4 gap-3">
        <span>CPU</span>
        <span>{t("publicAgents.card.ram")}</span>
        <span>{t("publicAgents.card.disk")}</span>
        <span>{t("publicAgents.card.traffic")}</span>
      </div>
      <div className="min-w-0">{t("publicAgents.summary.speed")}</div>
      <div className="min-w-0">{t("publicAgents.table.uptime")}</div>
      <div className="min-w-0">{t("publicAgents.table.expiry")}</div>
      <div className="min-w-0 flex-1">{t("publicAgents.table.tags")}</div>
    </div>
  );
}

export const AgentListRowCompact = React.memo(function AgentListRowCompact({
  a,
}: {
  a: PublicAgentSummary;
}) {
  const { t } = useTranslation();
  const s = computeStaticAgentMetrics(a);

  return (
    <div className="hina-agent-list-row border-b px-4 py-3 transition-colors hover:bg-accent/5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CountryFlag code={s.countryCode} className="text-sm" />
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${a.status.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
          />
          <Link
            className="truncate text-sm font-semibold leading-tight hover:underline"
            to={`/agents/${a.id}`}
          >
            {a.name}
          </Link>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <OsIcon os={a.system.os} className="size-3" />
          {formatOsShort(a.system.os)}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-3">
        <MiniBar label="CPU" pct={s.cpuPct} />
        <MiniBar label={t("publicAgents.card.ram")} pct={s.memPct} />
        <MiniBar label={t("publicAgents.card.disk")} pct={s.diskPct} />
        <MiniBar label={t("publicAgents.card.traffic")} pct={s.trafficPct} />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
        <span><span className="font-sans">↑ </span>{formatRateBytesPerSec(s.txRate)}</span>
        <span><span className="font-sans">↓ </span>{formatRateBytesPerSec(s.rxRate)}</span>
        <span className="inline-flex items-center gap-1">
          <HugeiconsIcon icon={Timer01Icon} strokeWidth={2} className="size-3" />
          <AgentUptime a={a} />
        </span>
        <AgentExpiryInfo a={a} inline />
      </div>

      {s.pricingLabel || a.tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.pricingLabel ? (
            <PricingBadge label={s.pricingLabel} prefix={t("publicAgents.card.price")} />
          ) : null}
          {a.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
