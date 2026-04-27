import type { AdminAgent, AgentPricing, BillingMode } from "@/api/adminAgents";
import type { patchAdminAgent } from "@/api/adminAgents";
import {
  EMPTY_PRICING,
  pricingAmountToUnit,
  pricingDateToMs,
  pricingMsToDate,
  pricingUnitToAmount,
  type PricingFormValues,
} from "@/components/PricingEditor";
import { formatBytes, parseBytes } from "@/lib/format";

export function formatQuotaInput(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return formatBytes(bytes);
}

export type AgentIpEntry = {
  family: "IPv4" | "IPv6";
  value: string;
};

export function getAgentIpEntries(status: AdminAgent["status"]): AgentIpEntry[] {
  const entries: AgentIpEntry[] = [];
  if (status.lastIpV4) entries.push({ family: "IPv4", value: status.lastIpV4 });
  if (status.lastIpV6) entries.push({ family: "IPv6", value: status.lastIpV6 });
  return entries;
}

export type EditFormValues = {
  name: string;
  groupName: string;
  isPublic: boolean;
  tags: string[];
  note: string;
  quotaInput: string;
  quotaBytes: number;
  mode: BillingMode;
  resetDay: string;
  pricing: PricingFormValues;
};

export type EditFormField = "quota" | "resetDay" | "pricingAmount";

export type EditPatchResult =
  | { kind: "noop" }
  | { kind: "error"; key: string; field: EditFormField }
  | { kind: "ok"; patch: Parameters<typeof patchAdminAgent>[1] };

export function buildEditPatch(current: EditFormValues, init: EditFormValues): EditPatchResult {
  const tagsJson = JSON.stringify(current.tags);
  const initTagsJson = JSON.stringify(init.tags);

  const metaDirty =
    current.name !== init.name ||
    current.groupName !== init.groupName ||
    current.isPublic !== init.isPublic ||
    tagsJson !== initTagsJson ||
    current.note !== init.note;

  const billingDirty =
    current.quotaInput !== init.quotaInput ||
    current.mode !== init.mode ||
    current.resetDay !== init.resetDay;

  const pricingDirty = JSON.stringify(current.pricing) !== JSON.stringify(init.pricing);

  if (!metaDirty && !billingDirty && !pricingDirty) return { kind: "noop" };

  let billing: { quotaBytes: number; mode: BillingMode; resetDay: number } | undefined;
  if (billingDirty) {
    const quotaDirty = current.quotaInput !== init.quotaInput;
    let quotaBytes: number;
    if (quotaDirty) {
      const parsed = parseBytes(current.quotaInput);
      if (parsed === null || parsed < 0)
        return { kind: "error", key: "agents.billing.invalidQuota", field: "quota" };
      quotaBytes = parsed;
    } else {
      quotaBytes = init.quotaBytes;
    }
    const rd = Number.parseInt(current.resetDay, 10);
    if (!Number.isFinite(rd) || rd < 1 || rd > 31)
      return { kind: "error", key: "agents.billing.resetDayError", field: "resetDay" };
    billing = { quotaBytes, mode: current.mode, resetDay: rd };
  }

  let pricing: AgentPricing | null | undefined;
  if (pricingDirty) {
    const hasAmount = current.pricing.amount.trim() !== "";
    const hasExpiry = current.pricing.expiresAt.trim() !== "";
    if (!hasAmount && !hasExpiry) {
      pricing = null;
    } else {
      const amountUnit = pricingAmountToUnit(current.pricing.amount);
      if (amountUnit === null)
        return { kind: "error", key: "agents.pricing.invalidAmount", field: "pricingAmount" };
      const expiresAtMs = pricingDateToMs(current.pricing.expiresAt);
      pricing = {
        currency: current.pricing.currency,
        cycle: current.pricing.cycle,
        amountUnit,
        expiresAtMs,
      };
    }
  }

  const patch: Parameters<typeof patchAdminAgent>[1] = {
    ...(metaDirty
      ? {
          name: current.name.trim(),
          groupName: current.groupName.trim() || null,
          isPublic: current.isPublic,
          tags: current.tags,
          note: current.note.trim() ? current.note : null,
        }
      : {}),
    ...(billing ? { billing } : {}),
    ...(pricing !== undefined ? { pricing } : {}),
  };

  return { kind: "ok", patch };
}

export function initEditFormValues(agent: AdminAgent): EditFormValues {
  return {
    name: agent.name,
    groupName: agent.group ?? "",
    isPublic: agent.isPublic,
    tags: agent.tags,
    note: agent.note ?? "",
    quotaInput: formatQuotaInput(agent.billing.quotaBytes),
    quotaBytes: agent.billing.quotaBytes,
    mode: agent.billing.mode,
    resetDay: String(agent.billing.resetDay),
    pricing: agent.pricing
      ? {
          currency: agent.pricing.currency,
          cycle: agent.pricing.cycle,
          amount: pricingUnitToAmount(agent.pricing.amountUnit),
          expiresAt: pricingMsToDate(agent.pricing.expiresAtMs),
        }
      : { ...EMPTY_PRICING },
  };
}
