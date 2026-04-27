import type { AgentInventory, PublicAgentSystem } from "./agentInfo";
import { fetchJson } from "./http";

export type PublicAgentListResponse = {
  agents: PublicAgentSummary[];
};

export type PublicBilling = {
  quotaBytes: number;
  mode: string;
  resetDay: number;
  periodStartDayYyyyMmDd: number;
  periodEndDayYyyyMmDd: number;
  rxBytes: number;
  txBytes: number;
  usedBytes: number;
  overQuota: boolean;
};

export type PublicAgentPricing = {
  currency: string;
  cycle: string;
  amountUnit: number;
  expiresAtMs: number | null;
};

export type PublicAgentSummary = {
  id: string;
  name: string;
  isPublic?: boolean;
  group: string | null;
  tags: string[];
  geo: {
    countryCode: string | null;
    country: string | null;
  };
  status: {
    online: boolean;
    lastSeenAtMs: number | null;
  };
  system: PublicAgentSystem;
  latest: PublicTelemetry | null;
  billing: PublicBilling | null;
  pricing: PublicAgentPricing | null;
};

export type PublicAgentDetailResponse = {
  id: string;
  name: string;
  isPublic?: boolean;
  group: string | null;
  tags: string[];
  geo: PublicAgentSummary["geo"];
  status: PublicAgentSummary["status"];
  system: PublicAgentSystem;
  inventory: AgentInventory | null;
  latest: PublicTelemetry | null;
  billing: PublicBilling | null;
  pricing: PublicAgentPricing | null;
};

export type PublicTelemetry = {
  seq: number;
  uptimeSec: number | null;
  rx: number;
  tx: number;
  m: Record<string, unknown>;
};

export type PublicAgentSeriesResponse =
  | { ok: false; code: string }
  | {
      ok: true;
      agentId: string;
      fromMs: number;
      toMs: number;
      resolution: "raw" | "auto";
      maxPoints: number;
      intervalSec: number;
      points: Array<{
        t: number;
        s: number;
        rx: number;
        tx: number;
        m: Record<string, number>;
      }>;
    };

export async function getPublicAgents(): Promise<PublicAgentListResponse> {
  return fetchJson<PublicAgentListResponse>("/api/public/agents");
}

export async function getPublicAgent(agentId: string): Promise<PublicAgentDetailResponse> {
  return fetchJson<PublicAgentDetailResponse>(`/api/public/agents/${encodeURIComponent(agentId)}`);
}

export async function getPublicAgentSeries(args: {
  agentId: string;
  fromMs: number;
  toMs: number;
  resolution: "raw" | "auto";
  maxPoints: number;
}): Promise<PublicAgentSeriesResponse> {
  const qs = new URLSearchParams({
    from: String(args.fromMs),
    to: String(args.toMs),
    resolution: args.resolution,
    maxPoints: String(args.maxPoints),
  });
  return fetchJson<PublicAgentSeriesResponse>(
    `/api/public/agents/${encodeURIComponent(args.agentId)}/series?${qs.toString()}`,
  );
}

export type PublicProbeKind = "icmp" | "tcp" | "http" | "traceroute";

export type PublicProbeTaskRef = {
  id: string;
  name: string | null;
  kind: PublicProbeKind | null;
  enabled: boolean;
  intervalSec: number;
  updatedAtMs: number;
};

export type PublicProbeLatest = {
  tsMs: number;
  recvTsMs: number;
  ok: boolean;
  latMs: number | null;
  code: number | null;
  err: string | null;
  extra: unknown | null;
  extraParseError: boolean;
  extraRawJson: string | null;
  lossPct: number | null;
  jitterMs: number | null;
  updatedAtMs: number;
};

export type PublicAgentProbeLatestResponse = {
  agentId: string;
  results: Array<{
    task: PublicProbeTaskRef;
    latest: PublicProbeLatest;
  }>;
};

export async function getPublicAgentProbeLatest(
  agentId: string,
): Promise<PublicAgentProbeLatestResponse> {
  return fetchJson<PublicAgentProbeLatestResponse>(
    `/api/public/agents/${encodeURIComponent(agentId)}/probe-latest`,
  );
}

export type PublicProbeSeriesTier = "auto" | "raw" | "hourly" | "daily";

export type PublicProbeSeriesResponse =
  | { ok: false; code: string; maxPoints?: number }
  | {
      ok: true;
      tier: "raw";
      intervalSec: null;
      agentId: string;
      taskId: string;
      fromMs: number;
      toMs: number;
      maxPoints: number;
      points: Array<{
        t: number;
        ok: boolean;
        latMs: number | null;
        lossPct: number | null;
        jitterMs: number | null;
      }>;
    }
  | {
      ok: true;
      tier: "hourly" | "daily";
      intervalSec: number;
      agentId: string;
      taskId: string;
      fromMs: number;
      toMs: number;
      maxPoints: number;
      points: Array<{
        t: number;
        samples: number;
        okSamples: number;
        latSamples: number;
        latAvgMs: number | null;
        latMinMs: number | null;
        latMaxMs: number | null;
        lossSamples: number;
        lossAvgPct: number | null;
        lossMaxPct: number | null;
        jitSamples: number;
        jitAvgMs: number | null;
        jitMaxMs: number | null;
      }>;
    };

export async function getPublicProbeResultsSeries(args: {
  agentId: string;
  taskId: string;
  fromMs: number;
  toMs: number;
  tier?: PublicProbeSeriesTier;
  maxPoints?: number;
}): Promise<PublicProbeSeriesResponse> {
  const qs = new URLSearchParams({
    agentId: args.agentId,
    taskId: args.taskId,
    from: String(args.fromMs),
    to: String(args.toMs),
  });
  if (args.tier) qs.set("tier", args.tier);
  if (args.maxPoints !== undefined) qs.set("maxPoints", String(args.maxPoints));
  return fetchJson<PublicProbeSeriesResponse>(`/api/public/probe-results/series?${qs.toString()}`);
}

export type PublicSiteConfig = {
  siteName: string;
  siteDescription: string;
  hasFavicon: boolean;
  faviconVersion: number;
  customFooterHtml: string;
  timezone: string;
  sortOfflineLast: boolean;
  hideTracerouteForGuests: boolean;
  serverVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
};

export async function getPublicSiteConfig(): Promise<PublicSiteConfig> {
  return fetchJson<PublicSiteConfig>("/api/public/site-config");
}
