import { isRecord } from "../util/lang";
import type { Result, ValidationError } from "./types";

export type AgentSelector =
  | { type: "all" }
  | { type: "agents"; agentIds: string[] }
  | { type: "groups"; groupIds: string[] };

export function matchesSelector(
  agent: { id: string; groupId: string | null },
  selector: AgentSelector,
): boolean {
  switch (selector.type) {
    case "all":
      return true;
    case "agents":
      return selector.agentIds.includes(agent.id);
    case "groups":
      return agent.groupId !== null && selector.groupIds.includes(agent.groupId);
  }
}

export function parseSelector(raw: unknown): Result<AgentSelector, ValidationError[]> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: [{ code: "invalid_selector", message: "selector must be an object" }],
    };
  }

  const type = raw["type"];

  if (type === "all") {
    return { ok: true, value: { type: "all" } };
  }

  if (type === "agents") {
    const agentIds = parseNonEmptyStringArray(raw["agentIds"]);
    if (agentIds === null) {
      return {
        ok: false,
        error: [
          {
            field: "selector.agentIds",
            code: "invalid_agent_ids",
            message: "agentIds must be a non-empty array of strings",
          },
        ],
      };
    }
    return { ok: true, value: { type: "agents", agentIds } };
  }

  if (type === "groups") {
    const groupIds = parseNonEmptyStringArray(raw["groupIds"]);
    if (groupIds === null) {
      return {
        ok: false,
        error: [
          {
            field: "selector.groupIds",
            code: "invalid_group_ids",
            message: "groupIds must be a non-empty array of strings",
          },
        ],
      };
    }
    return { ok: true, value: { type: "groups", groupIds } };
  }

  return {
    ok: false,
    error: [
      {
        field: "selector.type",
        code: "invalid_selector_type",
        message: 'selector.type must be "all", "agents", or "groups"',
      },
    ],
  };
}

function parseNonEmptyStringArray(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s) out.push(s);
  }
  if (out.length === 0) return null;
  return [...new Set(out)];
}
