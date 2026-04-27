import * as React from "react";
import { useTranslation } from "react-i18next";
import { Route } from "lucide-react";

import { TracerouteTraceDetail } from "@/components/probes/TracerouteTraceDetail";
import type { PublicAgentProbeLatestResponse, PublicProbeLatest } from "@/api/public";
import type { TracerouteExtraV1 } from "@/lib/traceroute";

export type TracerouteCardProps = {
  traceProbeResults: PublicAgentProbeLatestResponse["results"];
  selectedTraceTaskId: string | null;
  setSelectedTraceTaskId: (id: string | null) => void;
  traceLatest: PublicProbeLatest | null;
  traceExtra: TracerouteExtraV1 | null;
  canRenderTrace: boolean;
  rawTraceText: string;
};

export const TracerouteCard = React.memo(function TracerouteCard(props: TracerouteCardProps) {
  const { t } = useTranslation();
  const {
    traceProbeResults,
    selectedTraceTaskId,
    setSelectedTraceTaskId,
    traceLatest,
    traceExtra,
    canRenderTrace,
    rawTraceText,
  } = props;

  const selectedTask = traceProbeResults.find((r) => r.task.id === selectedTraceTaskId);

  if (traceProbeResults.length === 0) return null;

  return (
    <div className="hina-traceroute-card overflow-hidden rounded-2xl border border-border/50 bg-card backdrop-blur-sm">
      {/* Header */}
      <div className="border-b border-border/30 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="text-muted-foreground">
            <Route className="size-4" />
          </span>
          <h2 className="text-sm font-semibold uppercase tracking-wider">
            {t("publicAgent.traceroute.title")}
          </h2>
        </div>

        {/* Target toggles */}
        {traceProbeResults.length > 1 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {traceProbeResults.map((result) => {
              const selected = selectedTraceTaskId === result.task.id;
              const label = result.task.name ?? result.task.id.slice(0, 8);
              return (
                <button
                  key={result.task.id}
                  onClick={() => setSelectedTraceTaskId(result.task.id)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    selected
                      ? "border-border bg-muted/50"
                      : "border-border/50 bg-transparent opacity-50 hover:opacity-80"
                  }`}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ background: selected ? "#14b8a6" : "var(--color-muted-foreground)" }}
                  />
                  <span className={selected ? "text-foreground" : "text-muted-foreground"}>
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Content */}
      <div className="p-5">
        {traceLatest === null ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {t("common.noData")}
          </div>
        ) : canRenderTrace && traceExtra ? (
          <TracerouteTraceDetail
            extra={traceExtra}
            taskName={selectedTask?.task.name ?? undefined}
          />
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{t("probeResults.detail.rawJsonTitle")}</h3>
              <span className="text-xs text-muted-foreground">
                {traceLatest.extraParseError
                  ? t("probeResults.detail.extraParseError")
                  : t("probeResults.detail.unsupportedPayload")}
              </span>
            </div>
            <pre className="max-h-[60vh] overflow-auto rounded-xl border border-border/40 bg-muted/30 p-3 text-xs">
              {rawTraceText}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
});
