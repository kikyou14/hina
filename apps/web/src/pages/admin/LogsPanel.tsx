import { useVirtualizer } from "@tanstack/react-virtual";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { getAdminLogs } from "@/api/adminLogs";
import type { AdminLogEntry } from "@/api/adminLogs";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatIsoShort } from "@/lib/time";
import { getUserErrorMessage } from "@/lib/userErrors";
import { appendUniqueLogEntries, MAX_LOG_ENTRIES } from "./logEntries";

const POLL_INTERVAL_MS = 2000;
const LOG_ROW_ESTIMATE_PX = 24;
const LOG_OVERSCAN = 12;

type LoadMode = "reset" | "append" | "clear";

type ActiveRequest = {
  controller: AbortController;
  mode: LoadMode;
  version: number;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function levelVariant(
  level: AdminLogEntry["level"],
): "default" | "secondary" | "destructive" | "outline" {
  if (level === "error") return "destructive";
  if (level === "warn") return "secondary";
  return "outline";
}

export function LogsPanel() {
  const { t } = useTranslation();
  const { timezone } = useSiteConfig();
  const [auto, setAuto] = React.useState(true);
  const [stickToBottom, setStickToBottom] = React.useState(true);
  const [limit, setLimit] = React.useState(500);
  const [limitInput, setLimitInput] = React.useState("500");

  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [entries, setEntries] = React.useState<AdminLogEntry[]>([]);
  const [measurementEpoch, advanceMeasurementEpoch] = React.useReducer(
    (epoch: number) => epoch + 1,
    0,
  );

  const cursorRef = React.useRef<string | undefined>(undefined);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const activeRequestRef = React.useRef<ActiveRequest | null>(null);
  const pendingClearRef = React.useRef(false);
  const requestVersionRef = React.useRef(0);

  const getScrollElement = React.useCallback(() => listRef.current, []);
  const estimateRowSize = React.useCallback(() => LOG_ROW_ESTIMATE_PX, []);
  const getItemKey = React.useCallback((index: number) => entries[index]?.id ?? index, [entries]);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: entries.length,
    getScrollElement,
    estimateSize: estimateRowSize,
    getItemKey,
    overscan: LOG_OVERSCAN,
  });

  const commitLimit = React.useCallback(() => {
    const next = Math.min(Math.max(50, Number(limitInput) || 500), 2000);
    setLimit(next);
    setLimitInput(String(next));
  }, [limitInput]);

  const cancelActiveRequest = React.useCallback((mode?: LoadMode) => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest || (mode !== undefined && activeRequest.mode !== mode)) return;

    requestVersionRef.current += 1;
    activeRequest.controller.abort();
    activeRequestRef.current = null;
  }, []);

  const load = React.useCallback(
    async (mode: LoadMode): Promise<boolean> => {
      // Do not let append/reset cross a clear boundary until its server snapshot succeeds.
      const requestMode = pendingClearRef.current ? "clear" : mode;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      activeRequestRef.current?.controller.abort();
      const controller = new AbortController();
      activeRequestRef.current = { controller, mode: requestMode, version: requestVersion };

      try {
        setError(null);
        const res = await getAdminLogs({
          after: requestMode === "append" ? cursorRef.current : undefined,
          limit: requestMode === "clear" ? 0 : limit,
          signal: controller.signal,
        });

        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) {
          return false;
        }

        cursorRef.current = res.nextCursor;
        if (requestMode === "clear") {
          pendingClearRef.current = false;
          setEntries([]);
        } else if (requestMode === "reset" || res.reset) {
          setEntries(res.entries.slice(-MAX_LOG_ENTRIES));
        } else if (res.entries.length > 0) {
          setEntries((current) => appendUniqueLogEntries(current, res.entries));
        }

        setLoaded(true);
        return res.hasMore;
      } catch (err) {
        if (isAbortError(err) || requestVersion !== requestVersionRef.current) {
          return false;
        }
        setError(
          getUserErrorMessage(err, t, {
            action: "load",
            fallback: t("logs.failedToLoad"),
          }),
        );
        return false;
      } finally {
        if (activeRequestRef.current?.version === requestVersion) {
          activeRequestRef.current = null;
        }
      }
    },
    [limit, t],
  );

  React.useEffect(() => {
    void load("reset");
    return () => cancelActiveRequest();
  }, [cancelActiveRequest, load]);

  React.useEffect(() => {
    if (!auto) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delayMs: number) => {
      timer = setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      if (cancelled) return;
      if (activeRequestRef.current) {
        schedule(POLL_INTERVAL_MS);
        return;
      }

      const hasMore = await load(pendingClearRef.current ? "clear" : "append");
      if (!cancelled) schedule(hasMore ? 0 : POLL_INTERVAL_MS);
    };

    schedule(POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      cancelActiveRequest("append");
    };
  }, [auto, cancelActiveRequest, load]);

  const firstEntryId = entries[0]?.id;
  const previousFirstEntryIdRef = React.useRef(firstEntryId);
  React.useLayoutEffect(() => {
    if (previousFirstEntryIdRef.current === firstEntryId) return;
    previousFirstEntryIdRef.current = firstEntryId;
    rowVirtualizer.measure();
    advanceMeasurementEpoch();
  }, [firstEntryId, rowVirtualizer]);

  const lastEntryId = entries.at(-1)?.id;
  React.useLayoutEffect(() => {
    if (!stickToBottom || lastEntryId === undefined) return;
    rowVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
  }, [entries.length, lastEntryId, rowVirtualizer, stickToBottom]);

  const clearLogs = React.useCallback(() => {
    pendingClearRef.current = true;
    setEntries([]);
    setLoaded(true);
    void load("clear");
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>{t("logs.title")}</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("logs.auto")}</span>
              <Switch checked={auto} onCheckedChange={setAuto} />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("logs.stick")}</span>
              <Switch checked={stickToBottom} onCheckedChange={setStickToBottom} />
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
                onBlur={commitLimit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                className="w-28"
              />
              <Button variant="outline" onClick={() => void load("reset")}>
                {t("common.refresh")}
              </Button>
              <Button variant="outline" onClick={clearLogs}>
                {t("common.clear")}
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="text-destructive mb-3 text-sm" role="alert">
            {error}
          </div>
        ) : null}
        <div
          ref={listRef}
          className="bg-muted/30 h-130 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed"
        >
          {loaded && entries.length === 0 ? (
            <div className="text-muted-foreground">{t("logs.noLogs")}</div>
          ) : null}
          {entries.length > 0 ? (
            <div
              style={{
                height: rowVirtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const entry = entries[virtualRow.index];
                if (!entry) return null;

                return (
                  <div
                    key={`${measurementEpoch}:${virtualRow.key}`}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    className="flex gap-3"
                    style={{
                      left: 0,
                      position: "absolute",
                      top: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      width: "100%",
                    }}
                  >
                    <div className="text-muted-foreground w-37.5 shrink-0">
                      {formatIsoShort(entry.tsMs, timezone)}
                    </div>
                    <div className="w-18 shrink-0">
                      <Badge variant={levelVariant(entry.level)}>{entry.level}</Badge>
                    </div>
                    <div className="text-muted-foreground w-14 shrink-0">
                      {entry.source ?? "system"}
                    </div>
                    <div className="min-w-0 wrap-break-word whitespace-pre-wrap">{entry.msg}</div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
