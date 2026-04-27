import { usePublicSiteConfig } from "./public";

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const la = parse(latest);
  const ca = parse(current);
  const len = Math.max(la.length, ca.length);
  for (let i = 0; i < len; i++) {
    const l = la[i] ?? 0;
    const c = ca[i] ?? 0;
    if (l !== c) return l > c;
  }
  return false;
}

export function useLatestVersion() {
  const { data } = usePublicSiteConfig();
  const current = __APP_VERSION__;
  const latest = data?.latestVersion ?? null;
  const hasUpdate = latest !== null && isNewer(latest, current);

  return {
    current,
    latest,
    hasUpdate,
    releaseUrl: data?.releaseUrl ?? null,
  };
}
