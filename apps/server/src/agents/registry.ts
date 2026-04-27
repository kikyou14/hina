import { asc, eq } from "drizzle-orm";
import {
  computeOverQuota,
  computePeriodStartYyyyMmDdUtc,
  computeUsedBytes,
  normalizeBillingConfig,
  toYyyyMmDdUtc,
  type AgentBillingResult,
  type BillingConfig,
} from "../billing/billing";
import { queryTrafficRows } from "../billing/query";
import type { DbClient } from "../db/client";
import { agent, agentBilling, agentGroup, agentPricing, agentStatus } from "../db/schema";
import type { GeoResult } from "../geo/lookup";
import type { TelemetryIngestArgs, TelemetryIngestResult } from "../ingest/telemetry";
import {
  buildAgentPricing,
  decodeLatestTelemetry,
  parseTagsJson,
  type AgentPricingWire,
} from "../routes/helpers";
import {
  buildPublicSystemView,
  decodeInventoryPack,
  decodeJsonText,
  normalizeInventory,
  type AdminAgentSystemView,
  type AgentInventoryView,
  type PublicAgentSystemView,
} from "../util/agent-info";

export type AgentLatestWire = {
  seq: number;
  uptimeSec: number | null;
  rx: number;
  tx: number;
  m: Record<string, unknown>;
};

export type AgentPublicSummary = {
  id: string;
  name: string;
  isPublic: boolean;
  group: string | null;
  tags: string[];
  geo: { countryCode: string | null; country: string | null };
  status: { online: boolean; lastSeenAtMs: number | null };
  system: PublicAgentSystemView;
  latest: AgentLatestWire | null;
  billing: AgentBillingResult;
  pricing: AgentPricingWire | null;
};

export type AgentPublicDetail = AgentPublicSummary & {
  inventory: AgentInventoryView | null;
};

export type AgentAdminSummary = {
  id: string;
  name: string;
  isPublic: boolean;
  displayOrder: number;
  tags: string[];
  note: string | null;
  group: string | null;
  groupId: string | null;
  geo: { countryCode: string | null; country: string | null; source: string | null };
  status: {
    online: boolean;
    lastSeenAtMs: number | null;
    lastIpV4: string | null;
    lastIpV6: string | null;
  };
  system: AdminAgentSystemView;
  latest: AgentLatestWire | null;
  billing: AgentBillingResult;
  pricing: AgentPricingWire | null;
};

export type AgentAdminDetail = AgentAdminSummary & {
  inventory: AgentInventoryView | null;
};

export type AgentAlertPricing = { expiresAtMs: number; cycle: string };

export type AgentAlertView = {
  id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  lastSeenAtMs: number | null;
  metrics: Record<string, number>;
  billing: AgentBillingResult;
  pricing: AgentAlertPricing | null;
};

type AgentEntry = {
  id: string;
  name: string;
  isPublic: boolean;
  displayOrder: number;
  groupId: string | null;
  groupName: string | null;
  tags: string[];
  note: string | null;
  geoCountryCode: string | null;
  geoCountry: string | null;
  geoSource: string | null;
  online: boolean;
  lastSeenAtMs: number | null;
  lastIpV4: string | null;
  lastIpV6: string | null;
  lastHost: string | null;
  lastOs: string | null;
  lastArch: string | null;
  lastAgentVersion: string | null;
  lastCapabilities: unknown | null;
  lastHelloAtMs: number | null;
  latest: AgentLatestWire | null;
  inventory: AgentInventoryView | null;
  billingConfig: BillingConfig;
  periodStartDayYyyyMmDd: number;
  periodRxBytes: number;
  periodTxBytes: number;
  pendingPeriodRefresh: boolean;
  pricing: AgentPricingWire | null;
};

export type AgentInsertArgs = {
  id: string;
  name: string;
  isPublic: boolean;
  displayOrder: number;
  groupId: string | null;
  groupName: string | null;
  tags: string[];
  note: string | null;
  billingConfig: BillingConfig;
  pricing: AgentPricingWire | null;
  nowMs: number;
};

export type AgentPatchArgs = {
  name?: string;
  isPublic?: boolean;
  note?: string | null;
  tags?: string[];
  groupId?: string | null;
  groupName?: string | null;
  billingConfig?: BillingConfig;
  pricing?: AgentPricingWire | "delete";
};

export type HelloApplyArgs = {
  tsMs: number;
  host: string | null;
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  capabilities: unknown;
  inventory: unknown;
  ipV4: string | null;
  ipV6: string | null;
};

export type TelemetryApplyArgs = {
  args: TelemetryIngestArgs;
  result: TelemetryIngestResult;
};

export type IpApplyArgs = {
  tsMs: number;
  ipV4: string | null;
  ipV6: string | null;
};

export type ListFilter = {
  q?: string;
  groupId?: string;
  groupName?: string;
  isPublic?: boolean;
  online?: boolean;
  tags?: string[];
};

function matchesText(entry: AgentEntry, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.id.toLowerCase().includes(needle) ||
    (entry.note ?? "").toLowerCase().includes(needle) ||
    (entry.lastIpV4 ?? "").toLowerCase().includes(needle) ||
    (entry.lastIpV6 ?? "").toLowerCase().includes(needle) ||
    (entry.groupName ?? "").toLowerCase().includes(needle)
  );
}

function passesFilter(entry: AgentEntry, filter: ListFilter): boolean {
  if (filter.isPublic !== undefined && entry.isPublic !== filter.isPublic) return false;
  if (filter.groupId && entry.groupId !== filter.groupId) return false;
  if (filter.groupName) {
    const hay = (entry.groupName ?? "").toLowerCase();
    if (!hay.includes(filter.groupName.toLowerCase())) return false;
  }
  if (filter.online === true && !entry.online) return false;
  if (filter.online === false && entry.online) return false;
  if (filter.q && !matchesText(entry, filter.q)) return false;
  if (filter.tags && filter.tags.length > 0) {
    for (const tag of filter.tags) {
      if (!entry.tags.includes(tag)) return false;
    }
  }
  return true;
}

function compareEntries(a: AgentEntry, b: AgentEntry): number {
  if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
  return a.name.localeCompare(b.name);
}

export class AgentRegistry {
  private readonly db: DbClient;
  private readonly entries = new Map<string, AgentEntry>();
  private readonly patchLocks = new Map<string, Promise<unknown>>();
  private syncInflight: Promise<void> | null = null;
  private lastSyncAtMs = 0;

  constructor(db: DbClient) {
    this.db = db;
  }

  async load(): Promise<void> {
    const rows = await this.buildBaseQuery().orderBy(asc(agent.displayOrder), asc(agent.name));
    const nowMs = Date.now();
    const todayDay = toYyyyMmDdUtc(nowMs);

    const billingConfigs = new Map<string, BillingConfig>();
    let earliestPeriodStart = todayDay;
    for (const r of rows) {
      const config = this.normalizeBillingFromRow(r);
      billingConfigs.set(r.id, config);
      const periodStart = computePeriodStartYyyyMmDdUtc(nowMs, config.resetDay);
      if (periodStart < earliestPeriodStart) earliestPeriodStart = periodStart;
    }

    const trafficRows =
      rows.length > 0
        ? await queryTrafficRows(
            this.db,
            rows.map((r) => r.id),
            earliestPeriodStart,
            todayDay,
          )
        : [];

    const trafficByAgent = new Map<string, { rx: number; tx: number }>();
    for (const tr of trafficRows) {
      const config = billingConfigs.get(tr.agentId);
      if (!config) continue;
      const periodStart = computePeriodStartYyyyMmDdUtc(nowMs, config.resetDay);
      if (tr.dayYyyyMmDd < periodStart) continue;
      const agg = trafficByAgent.get(tr.agentId) ?? { rx: 0, tx: 0 };
      agg.rx += tr.rxBytes;
      agg.tx += tr.txBytes;
      trafficByAgent.set(tr.agentId, agg);
    }

    this.entries.clear();
    for (const r of rows) {
      const config = billingConfigs.get(r.id)!;
      const traffic = trafficByAgent.get(r.id) ?? { rx: 0, tx: 0 };
      this.entries.set(r.id, this.buildEntry(r, config, traffic, nowMs));
    }
  }

  async syncFromDb(): Promise<void> {
    const rows = await this.db.select({ id: agent.id }).from(agent);
    const dbIds = new Set(rows.map((r) => r.id));

    for (const id of this.entries.keys()) {
      if (!dbIds.has(id)) this.entries.delete(id);
    }

    const missingIds: string[] = [];
    for (const id of dbIds) {
      if (!this.entries.has(id)) missingIds.push(id);
    }
    if (missingIds.length === 0) return;

    await Promise.all(missingIds.map((id) => this.ensureAgent(id)));
  }

  async syncFromDbIfStale(ttlMs = 5_000): Promise<void> {
    if (this.syncInflight) return this.syncInflight;
    if (Date.now() - this.lastSyncAtMs < ttlMs) return;
    const run = this.runGatedSync();
    this.syncInflight = run;
    return run;
  }

  private async runGatedSync(): Promise<void> {
    try {
      await this.syncFromDb();
      this.lastSyncAtMs = Date.now();
    } finally {
      this.syncInflight = null;
    }
  }

  async ensureAgent(agentId: string): Promise<boolean> {
    if (this.entries.has(agentId)) return true;

    return this.runUnderPatchLock(agentId, async () => {
      if (this.entries.has(agentId)) return true;

      const rows = await this.buildBaseQuery().where(eq(agent.id, agentId)).limit(1);
      if (rows.length === 0) return false;
      const r = rows[0]!;

      const config = this.normalizeBillingFromRow(r);
      const nowMs = Date.now();
      const periodStart = computePeriodStartYyyyMmDdUtc(nowMs, config.resetDay);
      const todayDay = toYyyyMmDdUtc(nowMs);
      const trafficRows = await queryTrafficRows(this.db, [agentId], periodStart, todayDay);
      let rx = 0;
      let tx = 0;
      for (const tr of trafficRows) {
        rx += tr.rxBytes;
        tx += tr.txBytes;
      }

      const verify = await this.db
        .select({ id: agent.id })
        .from(agent)
        .where(eq(agent.id, agentId))
        .limit(1);
      if (verify.length === 0) return false;

      this.entries.set(agentId, this.buildEntry(r, config, { rx, tx }, nowMs));
      return true;
    });
  }

  private buildBaseQuery() {
    return this.db
      .select({
        id: agent.id,
        name: agent.name,
        isPublic: agent.isPublic,
        displayOrder: agent.displayOrder,
        groupId: agent.groupId,
        groupName: agentGroup.name,
        tagsJson: agent.tagsJson,
        note: agent.note,
        geoCountryCode: agent.geoCountryCode,
        geoCountry: agent.geoCountry,
        geoSource: agent.geoSource,
        online: agentStatus.online,
        lastSeenAtMs: agentStatus.lastSeenAtMs,
        lastIpV4: agentStatus.lastIpV4,
        lastIpV6: agentStatus.lastIpV6,
        lastHost: agentStatus.lastHost,
        lastOs: agentStatus.lastOs,
        lastArch: agentStatus.lastArch,
        lastAgentVersion: agentStatus.lastAgentVersion,
        lastCapabilitiesJson: agentStatus.lastCapabilitiesJson,
        lastHelloAtMs: agentStatus.lastHelloAtMs,
        lastMetricsPack: agentStatus.lastMetricsPack,
        lastInventoryPack: agentStatus.lastInventoryPack,
        billingQuotaBytes: agentBilling.quotaBytes,
        billingMode: agentBilling.mode,
        billingResetDay: agentBilling.resetDay,
        pricingCurrency: agentPricing.currency,
        pricingCycle: agentPricing.cycle,
        pricingAmountUnit: agentPricing.amountUnit,
        pricingExpiresAtMs: agentPricing.expiresAtMs,
      })
      .from(agent)
      .leftJoin(agentGroup, eq(agent.groupId, agentGroup.id))
      .leftJoin(agentStatus, eq(agent.id, agentStatus.agentId))
      .leftJoin(agentBilling, eq(agent.id, agentBilling.agentId))
      .leftJoin(agentPricing, eq(agent.id, agentPricing.agentId));
  }

  private normalizeBillingFromRow(r: {
    billingQuotaBytes: number | null;
    billingMode: string | null;
    billingResetDay: number | null;
  }): BillingConfig {
    return normalizeBillingConfig({
      quotaBytes: r.billingQuotaBytes ?? undefined,
      mode: r.billingMode ?? undefined,
      resetDay: r.billingResetDay ?? undefined,
    });
  }

  private buildEntry(
    r: Awaited<ReturnType<AgentRegistry["buildBaseQuery"]>>[number],
    config: BillingConfig,
    traffic: { rx: number; tx: number },
    nowMs: number,
  ): AgentEntry {
    const periodStart = computePeriodStartYyyyMmDdUtc(nowMs, config.resetDay);
    return {
      id: r.id,
      name: r.name,
      isPublic: r.isPublic,
      displayOrder: r.displayOrder,
      groupId: r.groupId ?? null,
      groupName: r.groupName ?? null,
      tags: parseTagsJson(r.tagsJson),
      note: r.note ?? null,
      geoCountryCode: r.geoCountryCode ?? null,
      geoCountry: r.geoCountry ?? null,
      geoSource: r.geoSource ?? null,
      online: r.online ?? false,
      lastSeenAtMs: r.lastSeenAtMs ?? null,
      lastIpV4: r.lastIpV4 ?? null,
      lastIpV6: r.lastIpV6 ?? null,
      lastHost: r.lastHost ?? null,
      lastOs: r.lastOs ?? null,
      lastArch: r.lastArch ?? null,
      lastAgentVersion: r.lastAgentVersion ?? null,
      lastCapabilities: decodeJsonText(r.lastCapabilitiesJson),
      lastHelloAtMs: r.lastHelloAtMs ?? null,
      latest: decodeLatestTelemetry(r.lastMetricsPack ?? null),
      inventory: decodeInventoryPack(r.lastInventoryPack ?? null),
      billingConfig: config,
      periodStartDayYyyyMmDd: periodStart,
      periodRxBytes: traffic.rx,
      periodTxBytes: traffic.tx,
      pendingPeriodRefresh: false,
      pricing: buildAgentPricing({
        pricingCurrency: r.pricingCurrency,
        pricingCycle: r.pricingCycle,
        pricingAmountUnit: r.pricingAmountUnit,
        pricingExpiresAtMs: r.pricingExpiresAtMs,
      }),
    };
  }

  insert(args: AgentInsertArgs): void {
    const periodStart = computePeriodStartYyyyMmDdUtc(args.nowMs, args.billingConfig.resetDay);
    this.entries.set(args.id, {
      id: args.id,
      name: args.name,
      isPublic: args.isPublic,
      displayOrder: args.displayOrder,
      groupId: args.groupId,
      groupName: args.groupName,
      tags: args.tags,
      note: args.note,
      geoCountryCode: null,
      geoCountry: null,
      geoSource: null,
      online: false,
      lastSeenAtMs: null,
      lastIpV4: null,
      lastIpV6: null,
      lastHost: null,
      lastOs: null,
      lastArch: null,
      lastAgentVersion: null,
      lastCapabilities: null,
      lastHelloAtMs: null,
      latest: null,
      inventory: null,
      billingConfig: args.billingConfig,
      periodStartDayYyyyMmDd: periodStart,
      periodRxBytes: 0,
      periodTxBytes: 0,
      pendingPeriodRefresh: false,
      pricing: args.pricing,
    });
  }

  remove(agentId: string): void {
    this.entries.delete(agentId);
  }

  async patch(agentId: string, patch: AgentPatchArgs): Promise<void> {
    return this.runUnderPatchLock(agentId, () => this.patchInner(agentId, patch));
  }

  async patchWithDb(
    agentId: string,
    patch: AgentPatchArgs,
    dbTask: () => Promise<AgentPatchArgs | void>,
  ): Promise<boolean> {
    return this.runUnderPatchLock(agentId, async () => {
      const snapshot = this.snapshotPatchFieldsUnlocked(agentId);
      if (snapshot === null) return false;
      await this.patchInner(agentId, patch);
      try {
        const afterDbPatch = await dbTask();
        if (afterDbPatch) await this.patchInner(agentId, afterDbPatch);
        return true;
      } catch (err) {
        await this.patchInner(agentId, snapshot);
        throw err;
      }
    });
  }

  private snapshotPatchFieldsUnlocked(agentId: string): AgentPatchArgs | null {
    const entry = this.entries.get(agentId);
    if (!entry) return null;
    return {
      name: entry.name,
      isPublic: entry.isPublic,
      note: entry.note,
      tags: [...entry.tags],
      groupId: entry.groupId,
      groupName: entry.groupName,
      billingConfig: { ...entry.billingConfig },
      pricing: entry.pricing === null ? "delete" : { ...entry.pricing },
    };
  }

  async runUnderPatchLock<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.patchLocks.get(agentId) ?? Promise.resolve();
    const chain = prev.catch(() => undefined).then(work);
    this.patchLocks.set(agentId, chain);
    try {
      return await chain;
    } finally {
      if (this.patchLocks.get(agentId) === chain) this.patchLocks.delete(agentId);
    }
  }

  private async patchInner(agentId: string, patch: AgentPatchArgs): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) return;

    if (patch.name !== undefined) entry.name = patch.name;
    if (patch.isPublic !== undefined) entry.isPublic = patch.isPublic;
    if (patch.note !== undefined) entry.note = patch.note;
    if (patch.tags !== undefined) entry.tags = patch.tags;
    if (patch.groupId !== undefined) entry.groupId = patch.groupId;
    if (patch.groupName !== undefined) entry.groupName = patch.groupName;

    if (patch.billingConfig !== undefined) {
      const prevConfig = entry.billingConfig;
      entry.billingConfig = patch.billingConfig;
      if (prevConfig.resetDay !== patch.billingConfig.resetDay) {
        entry.pendingPeriodRefresh = true;
      }
    }

    if (patch.pricing !== undefined) {
      entry.pricing = patch.pricing === "delete" ? null : patch.pricing;
    }
  }

  async drainPendingPeriodRefreshes(): Promise<void> {
    const pendingIds: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.pendingPeriodRefresh) pendingIds.push(entry.id);
    }
    for (const id of pendingIds) {
      await this.runUnderPatchLock(id, async () => {
        const entry = this.entries.get(id);
        if (!entry || !entry.pendingPeriodRefresh) return;
        await this.refreshPeriodTotals(entry);
        entry.pendingPeriodRefresh = false;
      });
    }
  }

  hasPendingPeriodRefreshes(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.pendingPeriodRefresh) return true;
    }
    return false;
  }

  reorder(agentIds: string[]): void {
    agentIds.forEach((id, index) => {
      const entry = this.entries.get(id);
      if (entry) entry.displayOrder = index;
    });
  }

  applyHello(agentId: string, args: HelloApplyArgs): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.online = true;
    entry.lastSeenAtMs = args.tsMs;
    entry.lastHelloAtMs = args.tsMs;
    entry.lastIpV4 = args.ipV4;
    entry.lastIpV6 = args.ipV6;
    entry.lastHost = args.host;
    entry.lastOs = args.os;
    entry.lastArch = args.arch;
    entry.lastAgentVersion = args.agentVersion;
    entry.lastCapabilities = args.capabilities ?? null;
    if (args.inventory !== undefined) {
      entry.inventory = normalizeInventory(args.inventory);
    }
  }

  applyTelemetryTraffic(agentId: string, apply: TelemetryApplyArgs): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const { args, result } = apply;

    const currentPeriodStart = computePeriodStartYyyyMmDdUtc(
      args.recvTsMs,
      entry.billingConfig.resetDay,
    );
    if (currentPeriodStart !== entry.periodStartDayYyyyMmDd) {
      entry.periodStartDayYyyyMmDd = currentPeriodStart;
      entry.periodRxBytes = 0;
      entry.periodTxBytes = 0;
    }
    entry.periodRxBytes += result.deltaRx;
    entry.periodTxBytes += result.deltaTx;
  }

  applyTelemetryLatest(agentId: string, apply: TelemetryApplyArgs): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const { args, result } = apply;

    entry.online = true;
    entry.lastSeenAtMs = args.recvTsMs;
    entry.latest = {
      seq: args.seq,
      uptimeSec: args.uptimeSec,
      rx: args.rxBytesTotal,
      tx: args.txBytesTotal,
      m: result.numericMetrics,
    };
  }

  applyIpUpdate(agentId: string, args: IpApplyArgs): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.online = true;
    entry.lastSeenAtMs = args.tsMs;
    entry.lastIpV4 = args.ipV4;
    entry.lastIpV6 = args.ipV6;
  }

  applyGeo(agentId: string, geo: GeoResult): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.geoCountryCode = geo.countryCode;
    entry.geoCountry = geo.country;
    entry.geoSource = geo.source;
  }

  async syncPricingFromDb(agentId: string): Promise<boolean> {
    return this.runUnderPatchLock(agentId, async () => {
      const entry = this.entries.get(agentId);
      if (!entry) return false;
      const rows = await this.db
        .select({
          currency: agentPricing.currency,
          cycle: agentPricing.cycle,
          amountUnit: agentPricing.amountUnit,
          expiresAtMs: agentPricing.expiresAtMs,
        })
        .from(agentPricing)
        .where(eq(agentPricing.agentId, agentId))
        .limit(1);
      entry.pricing =
        rows.length === 0
          ? null
          : buildAgentPricing({
              pricingCurrency: rows[0]!.currency,
              pricingCycle: rows[0]!.cycle,
              pricingAmountUnit: rows[0]!.amountUnit,
              pricingExpiresAtMs: rows[0]!.expiresAtMs,
            });
      return true;
    });
  }

  markOffline(agentId: string, tsMs: number): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.online = false;
    entry.lastSeenAtMs = tsMs;
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  size(): number {
    return this.entries.size;
  }

  listPublicSummaries(filter: ListFilter = {}, nowMs = Date.now()): AgentPublicSummary[] {
    const out: AgentPublicSummary[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.isPublic) continue;
      if (!passesFilter(entry, filter)) continue;
      out.push(this.toPublicSummary(entry, nowMs));
    }
    return out.sort((a, b) => this.compareById(a.id, b.id));
  }

  listSummaries(filter: ListFilter = {}, nowMs = Date.now()): AgentPublicSummary[] {
    const out: AgentPublicSummary[] = [];
    for (const entry of this.entries.values()) {
      if (!passesFilter(entry, filter)) continue;
      out.push(this.toPublicSummary(entry, nowMs));
    }
    return out.sort((a, b) => this.compareById(a.id, b.id));
  }

  listAdminSummaries(filter: ListFilter = {}, nowMs = Date.now()): AgentAdminSummary[] {
    const out: AgentAdminSummary[] = [];
    for (const entry of this.entries.values()) {
      if (!passesFilter(entry, filter)) continue;
      out.push(this.toAdminSummary(entry, nowMs));
    }
    return out.sort((a, b) => this.compareById(a.id, b.id));
  }

  listOptionRefs(): { id: string; name: string; group: string | null }[] {
    const out: { id: string; name: string; group: string | null }[] = [];
    for (const entry of this.entries.values()) {
      out.push({ id: entry.id, name: entry.name, group: entry.groupName });
    }
    return out.sort((a, b) => this.compareById(a.id, b.id));
  }

  listForAlert(nowMs = Date.now()): AgentAlertView[] {
    const out: AgentAlertView[] = [];
    for (const entry of this.entries.values()) {
      out.push(this.toAlertView(entry, nowMs));
    }
    return out.sort((a, b) => this.compareById(a.id, b.id));
  }

  getSummary(agentId: string, nowMs = Date.now()): AgentPublicSummary | null {
    const entry = this.entries.get(agentId);
    return entry ? this.toPublicSummary(entry, nowMs) : null;
  }

  getPublicDetail(agentId: string, nowMs = Date.now()): AgentPublicDetail | null {
    const entry = this.entries.get(agentId);
    if (!entry || !entry.isPublic) return null;
    return { ...this.toPublicSummary(entry, nowMs), inventory: entry.inventory };
  }

  getDetail(agentId: string, nowMs = Date.now()): AgentPublicDetail | null {
    const entry = this.entries.get(agentId);
    if (!entry) return null;
    return { ...this.toPublicSummary(entry, nowMs), inventory: entry.inventory };
  }

  getAdminDetail(agentId: string, nowMs = Date.now()): AgentAdminDetail | null {
    const entry = this.entries.get(agentId);
    if (!entry) return null;
    return { ...this.toAdminSummary(entry, nowMs), inventory: entry.inventory };
  }

  private compareById(aId: string, bId: string): number {
    const a = this.entries.get(aId);
    const b = this.entries.get(bId);
    if (!a || !b) return 0;
    return compareEntries(a, b);
  }

  private buildBilling(entry: AgentEntry, nowMs: number): AgentBillingResult {
    const todayDay = toYyyyMmDdUtc(nowMs);
    const currentPeriodStart = computePeriodStartYyyyMmDdUtc(nowMs, entry.billingConfig.resetDay);

    const rx = currentPeriodStart === entry.periodStartDayYyyyMmDd ? entry.periodRxBytes : 0;
    const tx = currentPeriodStart === entry.periodStartDayYyyyMmDd ? entry.periodTxBytes : 0;

    const usedBytes = computeUsedBytes(entry.billingConfig.mode, rx, tx);
    const overQuota = computeOverQuota(entry.billingConfig.quotaBytes, usedBytes);

    return {
      quotaBytes: entry.billingConfig.quotaBytes,
      mode: entry.billingConfig.mode,
      resetDay: entry.billingConfig.resetDay,
      periodStartDayYyyyMmDd: currentPeriodStart,
      periodEndDayYyyyMmDd: todayDay,
      rxBytes: rx,
      txBytes: tx,
      usedBytes,
      overQuota,
    };
  }

  private toPublicSummary(entry: AgentEntry, nowMs: number): AgentPublicSummary {
    return {
      id: entry.id,
      name: entry.name,
      isPublic: entry.isPublic,
      group: entry.groupName,
      tags: entry.tags,
      geo: { countryCode: entry.geoCountryCode, country: entry.geoCountry },
      status: { online: entry.online, lastSeenAtMs: entry.lastSeenAtMs },
      system: buildPublicSystemView({
        os: entry.lastOs,
        arch: entry.lastArch,
        agentVersion: entry.lastAgentVersion,
        helloAtMs: entry.lastHelloAtMs,
      }),
      latest: entry.latest,
      billing: this.buildBilling(entry, nowMs),
      pricing: entry.pricing,
    };
  }

  private toAdminSummary(entry: AgentEntry, nowMs: number): AgentAdminSummary {
    return {
      id: entry.id,
      name: entry.name,
      isPublic: entry.isPublic,
      displayOrder: entry.displayOrder,
      tags: entry.tags,
      note: entry.note,
      group: entry.groupName,
      groupId: entry.groupId,
      geo: {
        countryCode: entry.geoCountryCode,
        country: entry.geoCountry,
        source: entry.geoSource,
      },
      status: {
        online: entry.online,
        lastSeenAtMs: entry.lastSeenAtMs,
        lastIpV4: entry.lastIpV4,
        lastIpV6: entry.lastIpV6,
      },
      system: {
        host: entry.lastHost,
        os: entry.lastOs,
        arch: entry.lastArch,
        agentVersion: entry.lastAgentVersion,
        helloAtMs: entry.lastHelloAtMs,
        capabilities: entry.lastCapabilities,
      },
      latest: entry.latest,
      billing: this.buildBilling(entry, nowMs),
      pricing: entry.pricing,
    };
  }

  private toAlertView(entry: AgentEntry, nowMs: number): AgentAlertView {
    return {
      id: entry.id,
      name: entry.name,
      groupId: entry.groupId,
      groupName: entry.groupName,
      lastSeenAtMs: entry.lastSeenAtMs,
      metrics: pickNumericMetrics(entry.latest?.m),
      billing: this.buildBilling(entry, nowMs),
      pricing: toAlertPricing(entry.pricing),
    };
  }

  private async refreshPeriodTotals(entry: AgentEntry): Promise<void> {
    const nowMs = Date.now();
    const periodStart = computePeriodStartYyyyMmDdUtc(nowMs, entry.billingConfig.resetDay);
    const todayDay = toYyyyMmDdUtc(nowMs);
    const rows = await queryTrafficRows(this.db, [entry.id], periodStart, todayDay);
    let rx = 0;
    let tx = 0;
    for (const r of rows) {
      rx += r.rxBytes;
      tx += r.txBytes;
    }
    entry.periodStartDayYyyyMmDd = periodStart;
    entry.periodRxBytes = rx;
    entry.periodTxBytes = tx;
  }
}

function pickNumericMetrics(raw: Record<string, unknown> | undefined): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function toAlertPricing(pricing: AgentPricingWire | null): AgentAlertPricing | null {
  if (!pricing || pricing.expiresAtMs === null) return null;
  return { expiresAtMs: pricing.expiresAtMs, cycle: pricing.cycle };
}
