import { decode } from "@msgpack/msgpack";
import { isRecord } from "./lang";

export type AgentGpuView = {
  name: string | null;
  vendor: string | null;
  vendorId: string | null;
  deviceId: string | null;
  driver: string | null;
};

export type AgentInventoryView = {
  [key: string]: unknown;
  cpu_brand: string | null;
  cpu_vendor: string | null;
  cpu_count: number | null;
  kernel_version: string | null;
  virtualization: string | null;
  mem_total_bytes: number | null;
  swap_total_bytes: number | null;
  disk_total_bytes: number | null;
  disk_available_bytes: number | null;
  net_rx_total_bytes: number | null;
  net_tx_total_bytes: number | null;
  gpus: AgentGpuView[];
};

export type PublicAgentSystemView = {
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  helloAtMs: number | null;
};

export type AdminAgentSystemView = PublicAgentSystemView & {
  host: string | null;
  capabilities: unknown | null;
};

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeGpu(value: unknown): AgentGpuView | null {
  if (!isRecord(value)) return null;
  return {
    name: asOptionalString(value["name"]),
    vendor: asOptionalString(value["vendor"]),
    vendorId: asOptionalString(value["vendor_id"]),
    deviceId: asOptionalString(value["device_id"]),
    driver: asOptionalString(value["driver"]),
  };
}

export function normalizeInventory(value: unknown): AgentInventoryView | null {
  if (!isRecord(value)) return null;

  const gpus = Array.isArray(value["gpus"])
    ? value["gpus"].map(normalizeGpu).filter((entry): entry is AgentGpuView => entry !== null)
    : [];

  return {
    ...value,
    cpu_brand: asOptionalString(value["cpu_brand"]),
    cpu_vendor: asOptionalString(value["cpu_vendor"]),
    cpu_count: asOptionalNumber(value["cpu_count"]),
    kernel_version: asOptionalString(value["kernel_version"]),
    virtualization: asOptionalString(value["virtualization"]),
    mem_total_bytes: asOptionalNumber(value["mem_total_bytes"]),
    swap_total_bytes: asOptionalNumber(value["swap_total_bytes"]),
    disk_total_bytes: asOptionalNumber(value["disk_total_bytes"]),
    disk_available_bytes: asOptionalNumber(value["disk_available_bytes"]),
    net_rx_total_bytes: asOptionalNumber(value["net_rx_total_bytes"]),
    net_tx_total_bytes: asOptionalNumber(value["net_tx_total_bytes"]),
    gpus,
  };
}

export function decodeInventoryPack(pack: Buffer | null): AgentInventoryView | null {
  if (!pack) return null;
  try {
    return normalizeInventory(decode(pack));
  } catch {
    return null;
  }
}

export function decodeJsonText(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function buildPublicSystemView(args: {
  os: string | null | undefined;
  arch: string | null | undefined;
  agentVersion: string | null | undefined;
  helloAtMs: number | null | undefined;
}): PublicAgentSystemView {
  return {
    os: args.os ?? null,
    arch: args.arch ?? null,
    agentVersion: args.agentVersion ?? null,
    helloAtMs: args.helloAtMs ?? null,
  };
}

export function buildAdminSystemView(args: {
  host: string | null | undefined;
  os: string | null | undefined;
  arch: string | null | undefined;
  agentVersion: string | null | undefined;
  helloAtMs: number | null | undefined;
  capabilitiesJson: string | null | undefined;
}): AdminAgentSystemView {
  return {
    host: args.host ?? null,
    os: args.os ?? null,
    arch: args.arch ?? null,
    agentVersion: args.agentVersion ?? null,
    helloAtMs: args.helloAtMs ?? null,
    capabilities: decodeJsonText(args.capabilitiesJson),
  };
}
