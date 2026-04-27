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

  const sinceRef = React.useRef<number | undefined>(undefined);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const trimAndSet = React.useCallback((next: AdminLogEntry[]) => {
    const max = 5000;
    if (next.length <= max) return next;
    return next.slice(next.length - max);
  }, []);

  const commitLimit = React.useCallback(() => {
    const next = Math.min(Math.max(50, Number(limitInput) || 500), 2000);
    setLimit(next);
    setLimitInput(String(next));
  }, [limitInput]);

  const load = React.useCallback(
    async (mode: "reset" | "append") => {
      try {
        setError(null);
        const res = await getAdminLogs({
          limit,
          sinceTsMs: mode === "append" ? sinceRef.current : undefined,
        });

        if (mode === "reset") {
          setEntries(res.entries);
        } else if (res.entries.length > 0) {
          setEntries((prev) => trimAndSet([...prev, ...res.entries]));
        }

        const last = res.entries.length ? res.entries[res.entries.length - 1] : null;
        if (last) sinceRef.current = last.tsMs;
        setLoaded(true);
      } catch (err) {
        setError(
          getUserErrorMessage(err, t, {
            action: "load",
            fallback: t("logs.failedToLoad"),
          }),
        );
      }
    },
    [limit, trimAndSet, t],
  );

  React.useEffect(() => {
    void load("reset");
  }, [load]);

  React.useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void load("append"), 2000);
    return () => clearInterval(timer);
  }, [auto, load]);

  React.useEffect(() => {
    if (!stickToBottom) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, stickToBottom]);

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
              <Button
                variant="outline"
                onClick={() => {
                  sinceRef.current = Date.now();
                  setEntries([]);
                }}
              >
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
          {loaded && entries.length === 0 && (
            <div className="text-muted-foreground">{t("logs.noLogs")}</div>
          )}
          {entries.map((e, idx) => (
            <div key={`${e.tsMs}:${idx}`} className="flex gap-3">
              <div className="text-muted-foreground w-37.5 shrink-0">
                {formatIsoShort(e.tsMs, timezone)}
              </div>
              <div className="w-18 shrink-0">
                <Badge variant={levelVariant(e.level)}>{e.level}</Badge>
              </div>
              <div className="text-muted-foreground w-14 shrink-0">{e.source ?? "system"}</div>
              <div className="min-w-0 wrap-break-word whitespace-pre-wrap">{e.msg}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
