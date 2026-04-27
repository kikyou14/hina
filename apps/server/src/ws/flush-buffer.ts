import type { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import type { AsnLookup } from "../geo/asn";
import { ingestProbeResultsBatch, type ProbeResultIngestArgs } from "../ingest/probe";
import {
  ingestTelemetryTrafficAndRollup,
  type TelemetryIngestArgs,
  type TelemetryIngestResult,
  upsertAgentStatusFromTelemetry,
} from "../ingest/telemetry";
import { ingestTracerouteResultsBatch, type RouteChangeEvent } from "../ingest/traceroute";
import type { BrowserLiveHub } from "../live/hub";

export type BufferedProbeResult = {
  bytes: number;
  args: ProbeResultIngestArgs;
  isTraceroute: boolean;
};

export type FlushBufferDeps = {
  db: DbClient;
  liveHub?: BrowserLiveHub;
  registry: AgentRegistry;
  asnLookup: AsnLookup | null;
  isAgentConnected: (agentId: string) => boolean;
  onRouteChanges: (changes: RouteChangeEvent[]) => void;
};

export type FlushBufferOptions = {
  maxProbeEntries: number;
  maxProbeBytes: number;
  flushIntervalMs: number;
  maxConsecutiveFailures?: number;
};

const PACK_WRITE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export class FlushBuffer {
  private readonly deps: FlushBufferDeps;
  private readonly options: FlushBufferOptions;
  private readonly maxConsecutiveFailures: number;

  private readonly telemetryBuffer = new Map<string, TelemetryIngestArgs>();
  private readonly lastPackWriteMs = new Map<string, number>();
  private probeBuffer: BufferedProbeResult[] = [];
  private probeBufferBytes = 0;
  private droppedProbeCount = 0;
  private droppedProbeBytes = 0;
  private consecutiveFailures = 0;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(deps: FlushBufferDeps, options: FlushBufferOptions) {
    this.deps = deps;
    this.options = options;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.options.flushIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.inflight) {
      try {
        await this.inflight;
      } catch {
        // doFlush swallows its own errors, but be defensive.
      }
    }
    await this.flush();
    this.reportDrops();
  }

  private tick(): void {
    this.reportDrops();
    void this.flush();
  }

  private reportDrops(): void {
    if (this.droppedProbeCount === 0) return;
    console.warn(
      `flush buffer dropped ${this.droppedProbeCount} probe results ` +
        `(${this.droppedProbeBytes} bytes) — buffer cap reached`,
    );
    this.droppedProbeCount = 0;
    this.droppedProbeBytes = 0;
  }

  enqueueTelemetry(args: TelemetryIngestArgs): void {
    this.telemetryBuffer.set(args.agentId, args);
  }

  enqueueProbeResult(entry: BufferedProbeResult): boolean {
    if (
      this.probeBuffer.length >= this.options.maxProbeEntries ||
      this.probeBufferBytes + entry.bytes > this.options.maxProbeBytes
    ) {
      this.droppedProbeCount += 1;
      this.droppedProbeBytes += entry.bytes;
      return false;
    }

    this.probeBuffer.push(entry);
    this.probeBufferBytes += entry.bytes;
    return true;
  }

  awaitInflight(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  removeAgent(agentId: string): void {
    this.telemetryBuffer.delete(agentId);
    this.lastPackWriteMs.delete(agentId);

    if (this.probeBuffer.length === 0) return;

    const next: BufferedProbeResult[] = [];
    let nextBytes = 0;
    for (const entry of this.probeBuffer) {
      if (entry.args.agentId === agentId) continue;
      next.push(entry);
      nextBytes += entry.bytes;
    }
    this.probeBuffer = next;
    this.probeBufferBytes = nextBytes;
  }

  private flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    const hasBufferWork = this.telemetryBuffer.size > 0 || this.probeBuffer.length > 0;
    const hasPendingRegistry = this.deps.registry.hasPendingPeriodRefreshes();
    if (!hasBufferWork && !hasPendingRegistry) {
      return Promise.resolve();
    }
    const run = this.doFlush().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async doFlush(): Promise<void> {
    const telemetryBatch = [...this.telemetryBuffer.values()];
    this.telemetryBuffer.clear();

    const probeBatch = this.probeBuffer;
    const probeBatchBytes = this.probeBufferBytes;
    this.probeBuffer = [];
    this.probeBufferBytes = 0;

    const allIngested: Array<{
      args: TelemetryIngestArgs;
      result: TelemetryIngestResult;
    }> = [];
    const telemetryLiveBatch: Array<{
      args: TelemetryIngestArgs;
      result: TelemetryIngestResult;
    }> = [];
    const pendingPackWrites: Array<[string, number]> = [];
    let allowedProbeArgs: ProbeResultIngestArgs[] = [];
    let routeChanges: RouteChangeEvent[] = [];
    let txCommitted = false;

    try {
      await this.deps.db.transaction(async (tx) => {
        for (const args of telemetryBatch) {
          if (!this.deps.registry.has(args.agentId)) continue;

          const result = await ingestTelemetryTrafficAndRollup(tx, args);
          allIngested.push({ args, result });

          if (this.deps.isAgentConnected(args.agentId)) {
            const now = Date.now();
            const lastPack = this.lastPackWriteMs.get(args.agentId) ?? 0;
            const includePacks = now - lastPack >= PACK_WRITE_INTERVAL_MS;
            await upsertAgentStatusFromTelemetry(tx, args, includePacks);
            if (includePacks) pendingPackWrites.push([args.agentId, now]);
            telemetryLiveBatch.push({ args, result });
          }
        }

        const normalBatch: ProbeResultIngestArgs[] = [];
        const traceBatch: ProbeResultIngestArgs[] = [];
        for (const entry of probeBatch) {
          if (!this.deps.isAgentConnected(entry.args.agentId)) continue;
          if (entry.isTraceroute) traceBatch.push(entry.args);
          else normalBatch.push(entry.args);
        }
        allowedProbeArgs = [...normalBatch, ...traceBatch];

        await ingestProbeResultsBatch(tx, normalBatch);
        routeChanges = await ingestTracerouteResultsBatch(tx, traceBatch, this.deps.asnLookup);
      });
      txCommitted = true;

      for (const [agentId, ts] of pendingPackWrites) {
        this.lastPackWriteMs.set(agentId, ts);
      }

      for (const entry of allIngested) {
        this.deps.registry.applyTelemetryTraffic(entry.args.agentId, entry);
      }

      for (const entry of telemetryLiveBatch) {
        this.deps.registry.applyTelemetryLatest(entry.args.agentId, entry);
      }

      await this.deps.registry.drainPendingPeriodRefreshes();

      if (this.deps.liveHub) {
        try {
          this.deps.liveHub.publishTelemetryBatch(telemetryLiveBatch);
          this.deps.liveHub.publishProbeLatestBatch(allowedProbeArgs);
        } catch (err) {
          console.error("live hub publish failed", err);
        }
      }

      if (routeChanges.length > 0) {
        this.deps.onRouteChanges(routeChanges);
      }
    } catch (err) {
      console.error(txCommitted ? "flush post-commit step failed" : "flush db buffers failed", err);
    }

    if (txCommitted) {
      this.consecutiveFailures = 0;
      return;
    }

    if (probeBatch.length === 0 && telemetryBatch.length === 0) return;

    this.handleFlushFailure(probeBatch, probeBatchBytes, telemetryBatch);
  }

  private handleFlushFailure(
    probeBatch: BufferedProbeResult[],
    probeBatchBytes: number,
    telemetryBatch: TelemetryIngestArgs[],
  ): void {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      console.error(
        `flush buffer giving up after ${this.consecutiveFailures} consecutive failures; ` +
          `dropping ${probeBatch.length} probe results (${probeBatchBytes} bytes) ` +
          `and ${telemetryBatch.length} telemetry samples to break the retry loop`,
      );
      this.droppedProbeCount += probeBatch.length;
      this.droppedProbeBytes += probeBatchBytes;
      this.consecutiveFailures = 0;
      return;
    }

    this.requeueProbeBatch(probeBatch, probeBatchBytes);
    this.requeueTelemetryBatch(telemetryBatch);
  }

  private requeueProbeBatch(batch: BufferedProbeResult[], batchBytes: number): void {
    if (batch.length === 0) return;

    const merged = batch.concat(this.probeBuffer);
    let mergedBytes = batchBytes + this.probeBufferBytes;

    let droppedCount = 0;
    let droppedBytes = 0;
    while (
      merged.length > this.options.maxProbeEntries ||
      mergedBytes > this.options.maxProbeBytes
    ) {
      const removed = merged.pop();
      if (removed === undefined) break;
      mergedBytes -= removed.bytes;
      droppedCount += 1;
      droppedBytes += removed.bytes;
    }

    if (droppedCount > 0) {
      this.droppedProbeCount += droppedCount;
      this.droppedProbeBytes += droppedBytes;
    }

    this.probeBuffer = merged;
    this.probeBufferBytes = mergedBytes;
  }

  private requeueTelemetryBatch(batch: TelemetryIngestArgs[]): void {
    for (const args of batch) {
      const existing = this.telemetryBuffer.get(args.agentId);
      if (!existing || existing.recvTsMs < args.recvTsMs) {
        this.telemetryBuffer.set(args.agentId, args);
      }
    }
  }
}
