import type { TemplateVars } from "./template";

let _getTimezone: () => string = () => process.env.TZ || "Asia/Shanghai";

export function setAlertTimezoneProvider(provider: () => string) {
  _getTimezone = provider;
}

export type ValueLine = { label: string; text: string };

const METRIC_DISPLAY: Record<string, string> = {
  "cpu.usage_pct": "CPU Usage",
  "mem.used_pct": "Memory Usage",
  "mem.used_bytes": "Memory Used",
  "mem.total_bytes": "Memory Total",
  "swap.used_pct": "Swap Usage",
  "swap.used_bytes": "Swap Used",
  "swap.total_bytes": "Swap Total",
  "disk.used_pct": "Disk Usage",
  "disk.used_bytes": "Disk Used",
  "disk.total_bytes": "Disk Total",
  "net.rx_rate": "Network RX Rate",
  "net.tx_rate": "Network TX Rate",
  "load.1": "Load (1m)",
  "load.5": "Load (5m)",
  "load.15": "Load (15m)",
  "proc.count": "Process Count",
  "conn.tcp.count": "TCP Connections",
  "conn.udp.count": "UDP Connections",
  "conn.total.count": "Total Connections",
  "temp.max_c": "Max Temperature",
};

export function metricDisplayName(metric: string): string {
  return METRIC_DISPLAY[metric] ?? metric;
}

export function formatMetricValue(metric: string, value: number): string {
  if (metric.endsWith("_pct")) return `${round(value, 1)}%`;
  if (metric === "net.rx_rate" || metric === "net.tx_rate") return formatBytesRate(value);
  if (metric.endsWith("_bytes")) return formatBytes(value);
  if (metric === "temp.max_c") return `${round(value, 1)}°C`;
  return String(round(value, 2));
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${round(bytes / 1024, 1)} KB`;
  if (bytes < 1024 ** 3) return `${round(bytes / 1024 ** 2, 1)} MB`;
  if (bytes < 1024 ** 4) return `${round(bytes / 1024 ** 3, 2)} GB`;
  return `${round(bytes / 1024 ** 4, 2)} TB`;
}

export function formatBytesRate(bytesPerSec: number): string {
  const bps = bytesPerSec * 8;
  if (bps < 1_000) return `${round(bps, 0)} bps`;
  if (bps < 1_000_000) return `${round(bps / 1_000, 1)} Kbps`;
  if (bps < 1_000_000_000) return `${round(bps / 1_000_000, 2)} Mbps`;
  return `${round(bps / 1_000_000_000, 2)} Gbps`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${round(ms / 1000, 1)}s`;
  if (ms < 3_600_000) return `${round(ms / 60_000, 1)}m`;
  return `${round(ms / 3_600_000, 1)}h`;
}

export function formatTimestamp(tsMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _getTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(new Date(tsMs));

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

export function yyyyMmDdToDisplay(yyyyMmDd: number): string {
  const y = Math.floor(yyyyMmDd / 10000);
  const m = Math.floor((yyyyMmDd % 10000) / 100);
  const d = yyyyMmDd % 100;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function formatAsPath(fingerprint: string): string {
  if (!fingerprint) return "unknown";
  const parts = fingerprint.split(",").filter((s) => s.trim());
  if (parts.length === 0) return "unknown";
  return parts.map((asn) => `AS${asn.trim()}`).join(" → ");
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

export class TemplateVarsBuilder {
  private readonly values: Record<string, string> = {};
  private readonly rawKeys = new Set<string>();

  set(key: string, value: string): this {
    this.values[key] = value;
    return this;
  }

  setRaw(key: string, value: string): this {
    this.values[key] = value;
    this.rawKeys.add(key);
    return this;
  }

  build(): TemplateVars {
    return { values: { ...this.values }, rawKeys: this.rawKeys };
  }
}
