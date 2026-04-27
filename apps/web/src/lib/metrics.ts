export function getMetricNumber(
  metrics: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (!metrics) return null;
  const v = metrics[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
