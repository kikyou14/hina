import { useParams } from "react-router-dom";

import { usePublicAgent } from "@/queries/public";

export function useAgentData() {
  const params = useParams();
  const agentId = params.agentId ?? "";
  const agent = usePublicAgent(agentId);

  return { agentId, agent } as const;
}
