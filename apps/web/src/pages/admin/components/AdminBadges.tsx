import { useTranslation } from "react-i18next";

import type { ProbeKind } from "@/api/adminProbes";
import { Badge } from "@/components/ui/badge";

// One tint convention for every admin badge: a 10% wash plus a 600/400 text
// pair. Keep new badges on this map instead of hand-rolling classes, otherwise
// the same meaning drifts into two shades on adjacent columns.
export const BADGE_TINT = {
  green: "bg-green-500/10 text-green-600 dark:text-green-400",
  yellow: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  red: "bg-red-500/10 text-red-600 dark:text-red-400",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  purple: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
} as const;

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return enabled ? (
    <Badge className={BADGE_TINT.green}>{t("common.enabled")}</Badge>
  ) : (
    <Badge variant="destructive">{t("common.disabled")}</Badge>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: BADGE_TINT.red,
  warning: BADGE_TINT.yellow,
};

export function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      className={SEVERITY_STYLES[severity]}
      variant={severity === "info" ? "outline" : undefined}
    >
      {t(`alerts.severities.${severity}`, severity)}
    </Badge>
  );
}

const PROBE_KIND_STYLES: Record<ProbeKind, string> = {
  icmp: BADGE_TINT.blue,
  tcp: BADGE_TINT.emerald,
  http: BADGE_TINT.purple,
  traceroute: BADGE_TINT.amber,
};

export function ProbeKindBadge({ kind }: { kind: ProbeKind }) {
  return <Badge className={PROBE_KIND_STYLES[kind]}>{kind}</Badge>;
}
