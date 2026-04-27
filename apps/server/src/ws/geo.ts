import type { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import type { GeoLookup } from "../geo/lookup";
import type { BrowserLiveHub } from "../live/hub";
import { createLogger } from "../logging/logger";

const wsGeoLog = createLogger("ws");

export function resolveAndPublishAgentGeo(args: {
  db: DbClient;
  registry: AgentRegistry;
  liveHub?: BrowserLiveHub;
  geoLookup: GeoLookup;
  agentId: string;
  ip: string;
}): void {
  void args.geoLookup
    .resolveAgentGeo(args.db, args.agentId, args.ip)
    .then((geo) => {
      if (!geo) return;
      args.registry.applyGeo(args.agentId, geo);
      args.liveHub?.publishAdminGeo(args.agentId, geo);
      args.liveHub?.publishAgentChanges([args.agentId]);
    })
    .catch((err) => {
      wsGeoLog.error(`geo post-resolve failed: agent=${args.agentId} ip=${args.ip}`, err);
    });
}
