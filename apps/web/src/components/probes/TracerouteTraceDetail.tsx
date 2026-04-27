import { AlertCircle, AlertTriangle, ChevronRight, Globe, Route } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { TracerouteExtraV1 } from "@/lib/traceroute";

type Hop = TracerouteExtraV1["hops"][number];
type AsnInfo = NonNullable<Hop["responses"][number]["asn_info"]>;

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

function processHops(extra: TracerouteExtraV1): ProcessedHop[] {
  const { hops, start_ttl } = extra;
  if (hops.length === 0) return [];

  const result: ProcessedHop[] = [];

  if (hops[0].ttl > start_ttl) {
    pushPrivateGap(result, start_ttl, hops[0].ttl - 1);
  }

  let i = 0;
  while (i < hops.length) {
    if (i > 0 && hops[i].ttl > hops[i - 1].ttl + 1) {
      pushPrivateGap(result, hops[i - 1].ttl + 1, hops[i].ttl - 1);
    }

    if (hops[i].responses.length === 0) {
      const startIdx = i;
      while (i < hops.length && hops[i].responses.length === 0) {
        if (i > startIdx && hops[i].ttl > hops[i - 1].ttl + 1) break;
        i++;
      }
      result.push({
        type: "timeout_group",
        startTtl: hops[startIdx].ttl,
        endTtl: hops[i - 1].ttl,
        count: i - startIdx,
      });
    } else {
      result.push({ type: "normal", hop: hops[i] });
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

function groupByAsn(hops: TracerouteExtraV1["hops"]): AsnSegment[] {
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
  return SEGMENT_PALETTE[Math.abs(hash) % SEGMENT_PALETTE.length];
}

function SummarySection({ extra, taskName }: { extra: TracerouteExtraV1; taskName?: string }) {
  const { t } = useTranslation();
  const timedOut = extra.hops.filter((h) => h.responses.length === 0).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        variant="secondary"
        className={
          extra.destination_reached
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
            : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
        }
      >
        {extra.destination_reached
          ? t("probeResults.detail.completed")
          : t("probeResults.detail.incomplete")}
      </Badge>
      <SummaryStat icon={Globe} label={taskName ?? extra.target ?? extra.target_ip ?? "-"} />
      <SummaryStat
        icon={Route}
        label={t("probeResults.detail.hops", { count: extra.hops.length })}
      />
      {timedOut > 0 && (
        <SummaryStat
          icon={AlertCircle}
          label={`${timedOut} ${t("probeResults.detail.timeouts").toLowerCase()}`}
        />
      )}
    </div>
  );
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

function NetworkPath({ hops }: { hops: TracerouteExtraV1["hops"] }) {
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

export function TracerouteTraceDetail(props: { extra: TracerouteExtraV1; taskName?: string }) {
  const { t } = useTranslation();
  const processed = processHops(props.extra);

  return (
    <div className="space-y-5">
      <SummarySection extra={props.extra} taskName={props.taskName} />
      <NetworkPath hops={props.extra.hops} />

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
    </div>
  );
}
