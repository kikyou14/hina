import { AlertCircle, AlertTriangle, ChevronRight, Globe, Info, Route } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { TracerouteHop, TracerouteView } from "@/lib/traceroute";

type Hop = TracerouteHop;
type Trace = TracerouteView["traces"][number];
type AsnInfo = NonNullable<Hop["responses"][number]["asn_info"]>;
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

type ProcessedHop =
  | { type: "normal"; hop: Hop }
  | { type: "timeout_group"; startTtl: number; endTtl: number; count: number }
  | { type: "private_group"; startTtl: number; endTtl: number; count: number };

function pushPrivateGap(out: ProcessedHop[], fromTtl: number, toTtl: number) {
  if (toTtl < fromTtl) return;
  out.push({
    type: "private_group",
    startTtl: fromTtl,
    endTtl: toTtl,
    count: toTtl - fromTtl + 1,
  });
}

// The view model does not carry `start_ttl` (traceroute always starts at 1 in
// practice); hops missing between TTL 1 and the first reported hop are
// treated as filtered/private, same as any other gap in the sequence.
const ASSUMED_START_TTL = 1;

function processHops(hops: Hop[]): ProcessedHop[] {
  if (hops.length === 0) return [];

  const result: ProcessedHop[] = [];

  if (hops[0]!.ttl > ASSUMED_START_TTL) {
    pushPrivateGap(result, ASSUMED_START_TTL, hops[0]!.ttl - 1);
  }

  let i = 0;
  while (i < hops.length) {
    if (i > 0 && hops[i]!.ttl > hops[i - 1]!.ttl + 1) {
      pushPrivateGap(result, hops[i - 1]!.ttl + 1, hops[i]!.ttl - 1);
    }

    if (hops[i]!.responses.length === 0) {
      const startIdx = i;
      while (i < hops.length && hops[i]!.responses.length === 0) {
        if (i > startIdx && hops[i]!.ttl > hops[i - 1]!.ttl + 1) break;
        i++;
      }
      result.push({
        type: "timeout_group",
        startTtl: hops[startIdx]!.ttl,
        endTtl: hops[i - 1]!.ttl,
        count: i - startIdx,
      });
    } else {
      result.push({ type: "normal", hop: hops[i]! });
      i++;
    }
  }

  return result;
}

function formatRttMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  return `${ms.toFixed(1)}ms`;
}

function formatTtlRange(startTtl: number, endTtl: number): string {
  return startTtl === endTtl ? `#${startTtl}` : `#${startTtl}–#${endTtl}`;
}

function formatPacketSizeLabel(bytes: number | null): string {
  return bytes === null ? "-" : `${bytes} B`;
}

function describeErrorCode(code: string, t: TranslateFn): string {
  if (code === "packet_too_large") return t("probeResults.detail.errorPacketTooLarge");
  return code;
}

function isValidAsn(info: AsnInfo | null | undefined): info is AsnInfo {
  return info !== null && info !== undefined && Number.isFinite(info.asn) && info.asn > 0;
}

function latencyDotClass(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "bg-muted-foreground/40";
  if (ms < 30) return "bg-emerald-500";
  if (ms < 80) return "bg-amber-500";
  if (ms < 200) return "bg-orange-500";
  return "bg-rose-500";
}

function latencyTextClass(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "text-muted-foreground";
  if (ms < 30) return "text-emerald-600 dark:text-emerald-400";
  if (ms < 80) return "text-amber-600 dark:text-amber-400";
  if (ms < 200) return "text-orange-600 dark:text-orange-400";
  return "text-rose-600 dark:text-rose-400";
}

type AsnSegment = { key: string; label: string; hopCount: number };

function groupByAsn(hops: Hop[]): AsnSegment[] {
  const segments: AsnSegment[] = [];
  let current: AsnSegment | null = null;

  for (const hop of hops) {
    const info = hop.responses[0]?.asn_info;
    const key =
      hop.responses.length === 0
        ? "__timeout__"
        : isValidAsn(info)
          ? `AS${info.asn}`
          : "__private__";
    const label = key === "__timeout__" ? "* * *" : key === "__private__" ? "LAN" : key;

    if (current !== null && current.key === key) {
      current.hopCount++;
    } else {
      current = { key, label, hopCount: 1 };
      segments.push(current);
    }
  }

  return segments;
}

const SEGMENT_PALETTE = [
  {
    bg: "bg-teal-500/10",
    border: "border-teal-500/30",
    text: "text-teal-700 dark:text-teal-300",
    dot: "bg-teal-500",
  },
  {
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
    text: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  {
    bg: "bg-rose-500/10",
    border: "border-rose-500/30",
    text: "text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  {
    bg: "bg-violet-500/10",
    border: "border-violet-500/30",
    text: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
];

const MUTED_SEGMENT = {
  bg: "bg-muted/50",
  border: "border-border/50",
  text: "text-muted-foreground",
  dot: "bg-muted-foreground/40",
};

function segmentColorOf(key: string) {
  if (key === "__timeout__" || key === "__private__") return MUTED_SEGMENT;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  return SEGMENT_PALETTE[Math.abs(hash) % SEGMENT_PALETTE.length]!;
}

function SummaryStat({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

function NetworkPath({ hops }: { hops: Hop[] }) {
  const { t } = useTranslation();
  const segments = groupByAsn(hops);

  if (segments.length <= 1) return null;

  return (
    <div>
      <h3 className="text-muted-foreground mb-3 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
        <span className="size-1.5 rounded-full bg-teal-500" />
        {t("probeResults.detail.networkPath")}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {segments.map((seg, i) => {
          const color = segmentColorOf(seg.key);
          return (
            <div key={`${seg.key}-${i}`} className="flex items-center gap-1.5">
              <div
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 ${color.bg} ${color.border}`}
              >
                <span className={`size-1.5 rounded-full ${color.dot}`} />
                <span className={`text-xs font-medium ${color.text}`}>{seg.label}</span>
                <span className="text-muted-foreground text-[10px]">
                  {t("probeResults.detail.hops", { count: seg.hopCount })}
                </span>
              </div>
              {i < segments.length - 1 && (
                <ChevronRight className="text-muted-foreground/40 size-3.5" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimelineConnector({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="bg-border/50 mt-1 w-px flex-1" />;
}

function PrivateGroupRow({
  item,
  isLast,
}: {
  item: ProcessedHop & { type: "private_group" };
  isLast: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-stretch gap-4">
      <div className="flex w-8 shrink-0 flex-col items-center">
        <span className="text-muted-foreground/60 mb-2 font-mono text-[11px]">
          {formatTtlRange(item.startTtl, item.endTtl)}
        </span>
        <div className="bg-muted-foreground/20 z-10 size-2 rounded-sm" />
        <TimelineConnector show={!isLast} />
      </div>
      <div className="flex-1 pb-4">
        <span className="text-muted-foreground/60 text-sm italic">
          {t("probeResults.detail.internalHops", { count: item.count })}
        </span>
      </div>
    </div>
  );
}

function TimeoutGroupRow({
  item,
  isLast,
}: {
  item: ProcessedHop & { type: "timeout_group" };
  isLast: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-stretch gap-4">
      <div className="flex w-8 shrink-0 flex-col items-center">
        <span className="text-muted-foreground mb-2 font-mono text-[11px]">
          {formatTtlRange(item.startTtl, item.endTtl)}
        </span>
        <div className="border-muted-foreground/40 z-10 size-2.5 rounded-full border border-dashed" />
        <TimelineConnector show={!isLast} />
      </div>
      <div className="flex-1 pb-4">
        <div className="border-border/40 bg-muted/20 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2">
          <AlertTriangle className="text-muted-foreground/50 size-3.5 shrink-0" />
          <span className="text-muted-foreground text-sm">
            {t("probeResults.detail.hopsTimedOut", { count: item.count })}
          </span>
        </div>
      </div>
    </div>
  );
}

function NormalHopRow({ hop, isLast }: { hop: Hop; isLast: boolean }) {
  const primary = hop.responses[0];
  const moreCount = hop.responses.length > 1 ? hop.responses.length - 1 : 0;
  const hostname = primary?.hostname ?? null;
  const ip = primary?.ip ?? null;
  const asnInfo = primary?.asn_info;
  const asnTag = isValidAsn(asnInfo) ? `AS${asnInfo.asn}` : null;
  const asnOrg = isValidAsn(asnInfo) ? asnInfo.name?.trim() || null : null;
  const rtt = primary?.rtt_ms ?? null;

  return (
    <div className="flex items-stretch gap-4">
      <div className="flex w-8 shrink-0 flex-col items-center">
        <span className="text-muted-foreground mb-2 font-mono text-[11px]">#{hop.ttl}</span>
        <div className={`z-10 size-3 rounded-full ${latencyDotClass(rtt)}`} />
        <TimelineConnector show={!isLast} />
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="border-border/40 bg-muted/20 hover:border-border/60 hover:bg-muted/40 rounded-lg border p-3 transition-colors">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              {hostname && (
                <p className="truncate text-sm font-medium" title={hostname}>
                  {hostname}
                </p>
              )}
              {ip && <p className="text-muted-foreground truncate font-mono text-sm">{ip}</p>}
              {!hostname && !ip && <p className="text-muted-foreground text-sm">-</p>}
              {asnTag && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="rounded border border-teal-500/20 bg-teal-500/10 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:text-teal-300">
                    {asnTag}
                  </span>
                  {asnOrg && (
                    <span className="text-muted-foreground truncate text-[11px]" title={asnOrg}>
                      {asnOrg}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {moreCount > 0 && (
                <Badge variant="outline" className="h-5 px-1.5 text-xs">
                  +{moreCount}
                </Badge>
              )}
              <span className={`font-mono text-sm font-semibold ${latencyTextClass(rtt)}`}>
                {formatRttMs(rtt)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The single-path timeline shared by v1 results and the mobile per-size view. */
function SingleTraceRoute({ hops }: { hops: Hop[] }) {
  const { t } = useTranslation();
  const processed = processHops(hops);

  return (
    <>
      <NetworkPath hops={hops} />
      <div>
        <h3 className="text-muted-foreground mb-4 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
          <span className="size-1.5 rounded-full bg-teal-500" />
          {t("probeResults.detail.route")}
        </h3>
        <div>
          {processed.map((item, idx) => {
            const isLast = idx === processed.length - 1;
            if (item.type === "private_group") {
              return <PrivateGroupRow key={`p-${item.startTtl}`} item={item} isLast={isLast} />;
            }
            if (item.type === "timeout_group") {
              return <TimeoutGroupRow key={`t-${item.startTtl}`} item={item} isLast={isLast} />;
            }
            return <NormalHopRow key={item.hop.ttl} hop={item.hop} isLast={isLast} />;
          })}
        </div>
      </div>
    </>
  );
}

function SingleTraceSummary({
  view,
  trace,
  taskName,
}: {
  view: TracerouteView;
  trace: Trace;
  taskName?: string;
}) {
  const { t } = useTranslation();
  const timedOut = trace.hops.filter((h) => h.responses.length === 0).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        variant="secondary"
        className={
          trace.destinationReached
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
            : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
        }
      >
        {trace.destinationReached
          ? t("probeResults.detail.completed")
          : t("probeResults.detail.incomplete")}
      </Badge>
      <SummaryStat icon={Globe} label={taskName ?? view.target ?? view.targetIp ?? "-"} />
      <SummaryStat
        icon={Route}
        label={t("probeResults.detail.hops", { count: trace.hops.length })}
      />
      {timedOut > 0 && (
        <SummaryStat
          icon={AlertCircle}
          label={`${timedOut} ${t("probeResults.detail.timeouts").toLowerCase()}`}
        />
      )}
      {trace.errorCode && (
        <Badge variant="destructive">{describeErrorCode(trace.errorCode, t)}</Badge>
      )}
    </div>
  );
}

function SizeStatusBadge({ trace }: { trace: Trace }) {
  const { t } = useTranslation();
  const label = formatPacketSizeLabel(trace.packetSizeBytes);

  if (trace.destinationReached) {
    return (
      <Badge
        variant="secondary"
        className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
      >
        {label} · {t("probeResults.detail.completed")}
      </Badge>
    );
  }
  if (trace.errorCode) {
    return (
      <Badge
        variant="secondary"
        className="border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300"
      >
        {label} · {describeErrorCode(trace.errorCode, t)}
        {trace.pathMtuBytes !== null
          ? ` (${t("probeResults.detail.pathMtu", { mtu: trace.pathMtuBytes })})`
          : ""}
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
    >
      {label} · {t("probeResults.detail.incomplete")}
    </Badge>
  );
}

function DivergenceBadge({
  comparison,
  comparableHops,
}: {
  comparison: NonNullable<TracerouteView["comparison"]>;
  comparableHops: number;
}) {
  const { t } = useTranslation();
  if (!comparison.comparable) {
    return <Badge variant="outline">{t("probeResults.detail.routeNotComparable")}</Badge>;
  }
  if (comparison.routeDiverged) {
    return (
      <Badge
        variant="secondary"
        className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
      >
        {t("probeResults.detail.routeDiverged", { ttl: comparison.firstDivergingTtl })}
      </Badge>
    );
  }
  // Deliberately scoped to the comparable hops: TTLs where one side timed out
  return (
    <Badge
      variant="secondary"
      className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
    >
      {t("probeResults.detail.routeNoDifference", { count: comparableHops })}
    </Badge>
  );
}

function DualTraceSummary({
  view,
  traces,
  taskName,
}: {
  view: TracerouteView;
  traces: readonly [Trace, Trace];
  taskName?: string;
}) {
  const { t } = useTranslation();
  const [small, large] = traces;

  const comparableHops = React.useMemo(
    () =>
      buildTraceCompareRows(small.hops, large.hops, {
        leftFragHopTtl: small.fragHopTtl,
        rightFragHopTtl: large.fragHopTtl,
      }).filter((row) => row.left.status === "hop" && row.right.status === "hop" && !row.mtuLimited)
        .length,
    [small, large],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SummaryStat icon={Globe} label={taskName ?? view.target ?? view.targetIp ?? "-"} />
        <Badge variant="outline">{view.protocol.toUpperCase()}</Badge>
        {view.port !== null && (
          <SummaryStat icon={Route} label={t("probeResults.detail.port", { port: view.port })} />
        )}
        {view.probeStyle === "tcp_syn_payload" && (
          <Badge variant="outline">{t("probeResults.detail.probeStyleTcpSynPayload")}</Badge>
        )}
        <SizeStatusBadge trace={small} />
        <SizeStatusBadge trace={large} />
        {view.comparison && (
          <DivergenceBadge comparison={view.comparison} comparableHops={comparableHops} />
        )}
      </div>
      <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {t("probeResults.detail.synPayloadNotice")}
      </p>
    </div>
  );
}

type SideStatus = "hop" | "timeout" | "blank";

type CompareSide = { status: SideStatus; hop: Hop | null };

export type TraceCompareRow = {
  ttl: number;
  left: CompareSide;
  right: CompareSide;
  diverged: boolean;
  /** True when a side's hop at this TTL is the Fragmentation Needed reporter. */
  mtuLimited: boolean;
};

function classifySide(hopsByTtl: Map<number, Hop>, ttl: number): CompareSide {
  const hop = hopsByTtl.get(ttl);
  if (!hop) return { status: "blank", hop: null };
  if (hop.responses.length === 0) return { status: "timeout", hop };
  return { status: "hop", hop };
}

function primaryIp(side: CompareSide): string | null {
  if (side.status !== "hop") return null;
  return side.hop?.responses[0]?.ip ?? null;
}

export function buildTraceCompareRows(
  leftHops: Hop[],
  rightHops: Hop[],
  opts?: { leftFragHopTtl?: number | null; rightFragHopTtl?: number | null },
): TraceCompareRow[] {
  const leftFragHopTtl = opts?.leftFragHopTtl ?? null;
  const rightFragHopTtl = opts?.rightFragHopTtl ?? null;
  const leftByTtl = new Map(leftHops.map((h) => [h.ttl, h] as const));
  const rightByTtl = new Map(rightHops.map((h) => [h.ttl, h] as const));
  const maxTtl = [...leftHops, ...rightHops].reduce((max, h) => Math.max(max, h.ttl), 0);

  const rows: TraceCompareRow[] = [];
  for (let ttl = 1; ttl <= maxTtl; ttl++) {
    const left = classifySide(leftByTtl, ttl);
    const right = classifySide(rightByTtl, ttl);
    const leftIp = primaryIp(left);
    const rightIp = primaryIp(right);
    const mtuLimited =
      (left.status === "hop" && ttl === leftFragHopTtl) ||
      (right.status === "hop" && ttl === rightFragHopTtl);
    const diverged = !mtuLimited && leftIp !== null && rightIp !== null && leftIp !== rightIp;
    rows.push({ ttl, left, right, diverged, mtuLimited });
  }
  return rows;
}

function CompareCell({ side }: { side: CompareSide }) {
  const { t } = useTranslation();

  if (side.status === "blank") {
    return <div className="p-2" />;
  }
  if (side.status === "timeout") {
    return (
      <div className="border-border/40 bg-muted/20 text-muted-foreground flex items-center gap-1.5 rounded-lg border border-dashed p-2 text-xs">
        <AlertTriangle className="size-3 shrink-0" />
        {t("probeResults.detail.timeout")}
      </div>
    );
  }

  const hop = side.hop!;
  const primary = hop.responses[0];
  const hostname = primary?.hostname ?? null;
  const ip = primary?.ip ?? null;
  const asnInfo = primary?.asn_info;
  const asnTag = isValidAsn(asnInfo) ? `AS${asnInfo.asn}` : null;
  const rtt = primary?.rtt_ms ?? null;

  return (
    <div className="border-border/40 bg-muted/20 min-w-0 rounded-lg border p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-xs font-medium" title={hostname ?? ip ?? undefined}>
            {hostname ?? ip ?? "-"}
          </p>
          {asnTag && (
            <span className="rounded border border-teal-500/20 bg-teal-500/10 px-1 py-0.5 font-mono text-[9px] text-teal-700 dark:text-teal-300">
              {asnTag}
            </span>
          )}
        </div>
        <span className={`shrink-0 font-mono text-xs font-semibold ${latencyTextClass(rtt)}`}>
          {formatRttMs(rtt)}
        </span>
      </div>
    </div>
  );
}

function CompareRow({
  row,
  isFirstDivergence,
}: {
  row: TraceCompareRow;
  isFirstDivergence: boolean;
}) {
  const { t } = useTranslation();
  const highlightClass = isFirstDivergence
    ? "bg-amber-500/10 ring-1 ring-amber-500/40"
    : row.diverged
      ? "bg-amber-500/5"
      : "";

  return (
    <div
      className={`grid grid-cols-[3rem_1fr_1fr] items-center gap-2 rounded-lg p-1 ${highlightClass}`}
    >
      <div className="flex flex-col items-center justify-center gap-0.5">
        <span className="text-muted-foreground font-mono text-[11px]">#{row.ttl}</span>
        {isFirstDivergence && (
          <span className="rounded-full bg-amber-500/20 px-1 py-px text-center text-[8px] leading-tight font-semibold text-amber-700 dark:text-amber-300">
            {t("probeResults.detail.firstDivergence")}
          </span>
        )}
        {row.mtuLimited && (
          <span className="bg-muted text-muted-foreground rounded-full px-1 py-px text-center text-[8px] leading-tight font-semibold">
            {t("probeResults.detail.mtuLimitedHop")}
          </span>
        )}
      </div>
      <CompareCell side={row.left} />
      <CompareCell side={row.right} />
    </div>
  );
}

function SizeTogglePill({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
        selected
          ? "border-border bg-muted/50 text-foreground"
          : "border-border/50 text-muted-foreground bg-transparent opacity-60 hover:opacity-90"
      }`}
    >
      {label}
    </button>
  );
}

function DualTraceRoute({
  view,
  traces,
}: {
  view: TracerouteView;
  traces: readonly [Trace, Trace];
}) {
  const { t } = useTranslation();
  const [mobileIndex, setMobileIndex] = React.useState(0);
  const [small, large] = traces;
  const rows = React.useMemo(
    () =>
      buildTraceCompareRows(small.hops, large.hops, {
        leftFragHopTtl: small.fragHopTtl,
        rightFragHopTtl: large.fragHopTtl,
      }),
    [small, large],
  );
  const highlightTtl = view.comparison?.firstDivergingTtl ?? null;
  const mobileTrace = traces[mobileIndex] ?? small;

  return (
    <div>
      <h3 className="text-muted-foreground mb-4 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
        <span className="size-1.5 rounded-full bg-teal-500" />
        {t("probeResults.detail.route")}
      </h3>

      {/* Desktop: TTL-aligned two-column comparison. */}
      <div className="hidden md:block">
        <div className="text-muted-foreground mb-2 grid grid-cols-[3rem_1fr_1fr] gap-2 text-xs font-medium">
          <span />
          <span>{formatPacketSizeLabel(small.packetSizeBytes)}</span>
          <span>{formatPacketSizeLabel(large.packetSizeBytes)}</span>
        </div>
        <div className="space-y-1">
          {rows.map((row) => (
            <CompareRow key={row.ttl} row={row} isFirstDivergence={row.ttl === highlightTtl} />
          ))}
        </div>
      </div>

      {/* Mobile: switch between the two packet sizes instead of compressing columns. */}
      <div className="md:hidden">
        <div className="mb-3 flex flex-wrap gap-2">
          {traces.map((trace, idx) => (
            <SizeTogglePill
              key={idx}
              label={formatPacketSizeLabel(trace.packetSizeBytes)}
              selected={mobileIndex === idx}
              onSelect={() => setMobileIndex(idx)}
            />
          ))}
        </div>
        <SingleTraceRoute hops={mobileTrace.hops} />
      </div>
    </div>
  );
}

export function TracerouteTraceDetail(props: { view: TracerouteView; taskName?: string }) {
  const { view, taskName } = props;
  const orderedTraces = React.useMemo(
    () =>
      [...view.traces].sort(
        (a, b) =>
          (a.packetSizeBytes ?? Number.POSITIVE_INFINITY) -
          (b.packetSizeBytes ?? Number.POSITIVE_INFINITY),
      ),
    [view.traces],
  );

  if (orderedTraces.length >= 2) {
    const traces: readonly [Trace, Trace] = [orderedTraces[0]!, orderedTraces[1]!];
    return (
      <div className="space-y-5">
        <DualTraceSummary view={view} traces={traces} taskName={taskName} />
        <DualTraceRoute view={view} traces={traces} />
      </div>
    );
  }

  const trace = orderedTraces[0];
  if (!trace) return null;

  return (
    <div className="space-y-5">
      <SingleTraceSummary view={view} trace={trace} taskName={taskName} />
      <SingleTraceRoute hops={trace.hops} />
    </div>
  );
}
