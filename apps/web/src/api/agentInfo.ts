export type AgentGpuInfo = {
  name: string | null;
  vendor: string | null;
  vendorId: string | null;
  deviceId: string | null;
  driver: string | null;
};

export type AgentInventory = {
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
  gpus: AgentGpuInfo[];
};

export type PublicAgentSystem = {
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  helloAtMs: number | null;
};

export type AdminAgentSystem = PublicAgentSystem & {
  host: string | null;
  capabilities: unknown | null;
};
