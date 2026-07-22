import type { PublicAgentSummary } from "@/api/public";

export type PublicTelemetryDeltaV1 = {
  type: "event.public.telemetry_delta";
  agentId: string;
  tsMs: number;
  metrics: Record<string, number>;
  deltaRx: number;
  deltaTx: number;
};

export type PublicTelemetryDeltaV2 = PublicTelemetryDeltaV1 & {
  seq: number;
  uptimeSec: number | null;
  rx: number;
  tx: number;
  billing: PublicAgentSummary["billing"];
  traffic: PublicAgentSummary["traffic"];
};

export type PublicLiveMessage =
  | { type: "hello.public"; tsMs: number }
  | { type: "snapshot.public.agents"; agents: PublicAgentSummary[] }
  | { type: "event.public.agent_upsert"; agent: PublicAgentSummary }
  | { type: "event.public.agent_remove"; agentId: string }
  | PublicTelemetryDeltaV1;

export function isPublicTelemetryDeltaV2(
  message: PublicTelemetryDeltaV1,
): message is PublicTelemetryDeltaV2 {
  const candidate = message as Partial<PublicTelemetryDeltaV2>;
  return (
    typeof candidate.seq === "number" &&
    typeof candidate.rx === "number" &&
    typeof candidate.tx === "number" &&
    (typeof candidate.uptimeSec === "number" || candidate.uptimeSec === null) &&
    candidate.billing !== undefined &&
    candidate.traffic !== undefined
  );
}
