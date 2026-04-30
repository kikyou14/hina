import { getPricingCycleSuffix } from "./pricing-cycles";

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "-";
  if (!Number.isFinite(bytes)) return "-";
  const abs = Math.abs(bytes);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let u = 0;
  let v = abs;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const sign = bytes < 0 ? "-" : "";
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${sign}${v.toFixed(digits)} ${units[u]}`;
}

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const PiB = 1024 ** 5;

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: KiB,
  kib: KiB,
  mb: MiB,
  mib: MiB,
  gb: GiB,
  gib: GiB,
  tb: TiB,
  tib: TiB,
  pb: PiB,
  pib: PiB,
};

export function parseBytes(input: string): number | null {
  const s = input.trim();
  if (s === "") return 0;

  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([a-z]*)\s*$/i);
  if (!m) return null;

  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num) || num < 0) return null;

  const unitKey = (m[2] || "b").toLowerCase();
  const multiplier = BYTE_UNITS[unitKey];
  if (multiplier === undefined) return null;

  return Math.round(num * multiplier);
}

export function formatRateBytesPerSec(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined) return "-";
  if (!Number.isFinite(bytesPerSec)) return "-";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
}

const OS_RULES: [RegExp, string][] = [
  [/^Debian\b.*?(\d[\d.]*)/, "Debian $1"],
  [/^Ubuntu\s+(\d+\.\d+)/, "Ubuntu $1"],
  [/^CentOS\b.*?(\d[\d.]*)/, "CentOS $1"],
  [/^AlmaLinux\s+(\d[\d.]*)/, "AlmaLinux $1"],
  [/^Rocky\s+Linux\s+(\d[\d.]*)/, "Rocky $1"],
  [/^Windows\s+([\d.]+)/, "Windows $1"],
  [/^(\S+)\s.*?(\d[\d.]*)/, "$1 $2"],
];

export function formatOsShort(os: string | null | undefined): string {
  if (!os) return "-";
  for (const [re, tpl] of OS_RULES) {
    const m = os.match(re);
    if (m) return tpl.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
  }
  return os.length > 20 ? os.slice(0, 20) + "..." : os;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CNY: "¥",
  EUR: "€",
  GBP: "£",
  CHF: "Fr",
};

export function formatPricing(pricing: {
  currency: string;
  cycle: string;
  amountUnit: number;
}): string | null {
  if (pricing.amountUnit <= 0) return null;
  const symbol = CURRENCY_SYMBOLS[pricing.currency] ?? pricing.currency;
  const suffix = getPricingCycleSuffix(pricing.cycle) ?? `/${pricing.cycle}`;
  const amount = pricing.amountUnit / 100;
  const amountStr = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${symbol}${amountStr}${suffix}`;
}
