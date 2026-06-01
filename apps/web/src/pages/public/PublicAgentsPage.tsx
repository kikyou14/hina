import { motion } from "motion/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { GridViewIcon, ListViewIcon } from "@hugeicons/core-free-icons";

import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { PublicFooter } from "@/components/PublicFooter";
import { PublicHeader } from "@/components/PublicHeader";
import { QueryErrorCard } from "@/components/QueryErrorCard";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import type { PublicAgentSummary } from "@/api/public";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes, formatRateBytesPerSec } from "@/lib/format";
import { getMetricNumber } from "@/lib/metrics";
import { usePublicLiveSync } from "@/live/public";
import { usePublicAgents } from "@/queries/public";
import { AgentListPageSkeleton } from "./PublicAgentsPage.skeleton";
import { preloadAgentPageChunk } from "./AgentViews";
import { PublicAgentCardsVirtualGrid, PublicAgentListVirtualView } from "./VirtualAgentViews";

preloadAgentPageChunk();

const SCROLL_STORAGE_KEY = "hina.public.agents.scrollY";

export function PublicAgentsPage() {
  const { t } = useTranslation();
  const { sortOfflineLast } = useSiteConfig();
  useDocumentTitle();

  const agents = usePublicAgents();
  const { status: liveStatus } = usePublicLiveSync();

  const [view, setView] = React.useState<"cards" | "list">(() => {
    const stored = localStorage.getItem("hina.public.view");
    return stored === "list" ? "list" : "cards";
  });
  const toggleView = (v: "cards" | "list") => {
    setView(v);
    localStorage.setItem("hina.public.view", v);
  };

  const viewOptions = [
    { value: "cards" as const, icon: GridViewIcon, labelKey: "publicAgents.viewCards" },
    { value: "list" as const, icon: ListViewIcon, labelKey: "publicAgents.viewList" },
  ];

  const viewLayoutId = React.useId();
  const [q, setQ] = React.useState("");

  // Persist scroll position across SPA navigation. Save on unmount, restore
  // once the list data is available (React Query cache is warm on return).
  const scrollRestoredRef = React.useRef(false);
  React.useLayoutEffect(() => {
    if (scrollRestoredRef.current) return;
    if (!agents.data) return;
    scrollRestoredRef.current = true;
    const saved = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    if (saved === null) return;
    const y = Number.parseInt(saved, 10);
    if (Number.isFinite(y)) window.scrollTo(0, y);
  }, [agents.data]);
  React.useEffect(() => {
    return () => {
      sessionStorage.setItem(SCROLL_STORAGE_KEY, String(window.scrollY));
    };
  }, []);

  const filtered = React.useMemo(() => {
    const list = agents.data?.agents ?? [];
    const query = q.trim().toLowerCase();
    if (!query) return list;
    return list.filter((a) => {
      const hay = `${a.name} ${a.id} ${a.geo.countryCode ?? ""} ${a.geo.country ?? ""}`.toLowerCase();
      return hay.includes(query);
    });
  }, [agents.data?.agents, q]);

  const sorted = React.useMemo<PublicAgentSummary[]>(() => {
    if (!sortOfflineLast) return filtered;
    return [...filtered].sort((a, b) => {
      return (a.status.online ? 0 : 1) - (b.status.online ? 0 : 1);
    });
  }, [filtered, sortOfflineLast]);

  const stats = React.useMemo(() => {
    let online = 0;
    let billingTxBytes = 0;
    let billingRxBytes = 0;
    let hasBilling = false;
    let txRate = 0;
    let rxRate = 0;
    const regions = new Set<string>();

    for (const a of filtered) {
      if (a.status.online) online++;
      if (a.billing) {
        billingTxBytes += a.billing.txBytes;
        billingRxBytes += a.billing.rxBytes;
        hasBilling = true;
      }
      const m = a.latest?.m ?? null;
      const tx = getMetricNumber(m, "net.tx_rate");
      const rx = getMetricNumber(m, "net.rx_rate");
      if (tx !== null) txRate += tx;
      if (rx !== null) rxRate += rx;
      if (a.geo.countryCode) regions.add(a.geo.countryCode);
    }

    return { online, billingTxBytes, billingRxBytes, hasBilling, txRate, rxRate, regionCount: regions.size };
  }, [filtered]);

  return (
    <div className="hina-public-page flex min-h-dvh flex-col bg-background text-foreground">
      <PublicHeader />
      <ConnectionBanner status={liveStatus} />

      <main className="container flex-1 py-6">
        {/* Search + View toggle */}
        <div className="hina-search-bar mb-4 flex items-center gap-2">
          <Input
            id="agent-search"
            placeholder={t("publicAgents.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-sm"
          />
          <div className="hina-view-toggle ml-auto inline-flex items-center rounded-md border p-0.5">
            {viewOptions.map((opt) => (
              <Button
                key={opt.value}
                variant="ghost"
                size="sm"
                onClick={() => toggleView(opt.value)}
                className={`relative ${
                  view === opt.value ? "text-accent-foreground" : "text-muted-foreground"
                }`}
                title={t(opt.labelKey)}
              >
                <span className="relative z-10">
                  <HugeiconsIcon icon={opt.icon} strokeWidth={2} className="size-4" />
                </span>
                {view === opt.value && (
                  <motion.span
                    layoutId={viewLayoutId}
                    className="absolute inset-0 rounded-sm bg-accent"
                    transition={{ type: "spring", bounce: 0.15, duration: 0.5 }}
                  />
                )}
              </Button>
            ))}
          </div>
        </div>

        {/* Summary bar */}
        <div className="hina-summary-bar mb-6 grid grid-cols-2 overflow-hidden rounded-lg border lg:grid-cols-4">
          <div className="border-b border-r px-4 py-3 lg:border-b-0">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("publicAgents.summary.online")}
            </div>
            <div className="tabular-nums text-sm font-semibold sm:text-lg">
              {stats.online} / {filtered.length}
            </div>
          </div>
          <div className="border-b px-4 py-3 lg:border-b-0 lg:border-r">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("publicAgents.summary.regions")}
            </div>
            <div className="tabular-nums text-sm font-semibold sm:text-lg">{stats.regionCount}</div>
          </div>
          <div className="border-r px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("publicAgents.summary.traffic")}
            </div>
            <div className="tabular-nums text-sm font-semibold sm:text-lg">
              {stats.hasBilling ? (
                <>
                  <div className="sm:hidden">
                    <div><span className="font-sans">↑ </span>{formatBytes(stats.billingTxBytes)}</div>
                    <div><span className="font-sans">↓ </span>{formatBytes(stats.billingRxBytes)}</div>
                  </div>
                  <span className="hidden sm:inline">
                    <span className="font-sans">↑ </span>{formatBytes(stats.billingTxBytes)}
                    <span className="text-muted-foreground/60"> / </span>
                    <span className="font-sans">↓ </span>{formatBytes(stats.billingRxBytes)}
                  </span>
                </>
              ) : (
                "-"
              )}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("publicAgents.summary.speed")}
            </div>
            <div className="tabular-nums text-sm font-semibold sm:text-lg">
              <div className="sm:hidden">
                <div><span className="font-sans">↑ </span>{formatRateBytesPerSec(stats.txRate)}</div>
                <div><span className="font-sans">↓ </span>{formatRateBytesPerSec(stats.rxRate)}</div>
              </div>
              <span className="hidden sm:inline">
                <span className="font-sans">↑ </span>{formatRateBytesPerSec(stats.txRate)}
                <span className="text-muted-foreground/60"> / </span>
                <span className="font-sans">↓ </span>{formatRateBytesPerSec(stats.rxRate)}
              </span>
            </div>
          </div>
        </div>

        {/* Error state */}
        {agents.isError ? (
          <QueryErrorCard
            className="mb-6"
            error={agents.error}
            retrying={agents.isFetching}
            onRetry={() => agents.refetch()}
          />
        ) : null}

        {/* Agent views */}
        {!agents.data && !agents.isError ? (
          <AgentListPageSkeleton view={view} />
        ) : view === "list" ? (
          <PublicAgentListVirtualView agents={sorted} />
        ) : (
          <PublicAgentCardsVirtualGrid agents={sorted} />
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
