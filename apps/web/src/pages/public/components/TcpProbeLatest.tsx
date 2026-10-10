import { useTranslation } from "react-i18next";

import type { PublicProbeLatest } from "@/api/public";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { parseTcpProbeExtra, tcpProbeErrorKey } from "@/lib/probes";
import { formatLocalDateTime, formatMsNumber } from "../lib/chartHelpers";

export function TcpProbeLatest({ latest }: { latest: PublicProbeLatest }) {
  const { t } = useTranslation();
  const { timezone } = useSiteConfig();
  const extra = parseTcpProbeExtra(latest.extra);
  const errorKey = tcpProbeErrorKey(latest.err);

  return (
    <div className="mt-1.5 border-t border-border/40 pt-1.5 text-xs">
      <p className="text-muted-foreground">
        {t("probes.tcpResult.latest")}
        {extra ? ` · ${extra.packet_size_bytes} B` : null}
      </p>
      <p className={latest.ok ? "text-muted-foreground" : "text-destructive"}>
        {latest.ok ? t("probes.tcpResult.success") : t("probes.tcpResult.failed")}
        {latest.ok && latest.latMs !== null ? ` · ${formatMsNumber(latest.latMs)}` : null}
        {!latest.ok && errorKey ? ` · ${t(errorKey)}` : null}
      </p>
      <p className="text-[10px] text-muted-foreground/80">
        {formatLocalDateTime(latest.tsMs, timezone)}
      </p>
    </div>
  );
}
