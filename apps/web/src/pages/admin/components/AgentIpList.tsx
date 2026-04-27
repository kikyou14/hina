import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import type { AdminAgent } from "@/api/adminAgents";
import { getAgentIpEntries } from "../lib/agentEditHelpers";

function truncateIpv6(ip: string): string {
  if (ip.length <= 16) return ip;
  return `${ip.slice(0, 8)}…${ip.slice(-4)}`;
}

export function AgentIpList(props: { status: AdminAgent["status"]; align?: "left" | "right" }) {
  const { t } = useTranslation();
  const entries = getAgentIpEntries(props.status);
  if (entries.length === 0) return <span>-</span>;

  const copyIp = async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <div
      className={
        props.align === "right" ? "flex flex-col items-end gap-1 text-right" : "flex flex-col gap-1"
      }
    >
      {entries.map((entry) => (
        <div key={`${entry.family}-${entry.value}`} className="flex max-w-full items-center gap-2">
          <span className="text-muted-foreground shrink-0 text-[10px] uppercase">
            {entry.family}
          </span>
          <button
            type="button"
            className="cursor-pointer text-left font-mono text-xs break-all hover:underline"
            title={entry.family === "IPv6" ? entry.value : undefined}
            onClick={() => copyIp(entry.value)}
          >
            {entry.family === "IPv6" ? truncateIpv6(entry.value) : entry.value}
          </button>
        </div>
      ))}
    </div>
  );
}
