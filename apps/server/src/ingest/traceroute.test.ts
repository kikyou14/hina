import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import type { AsnInfo, AsnLookup } from "../geo/asn";
import { getMigrationsFolder } from "../paths";
import type { ProbeResultBody } from "../protocol/envelope";
import {
  buildTracerouteResultExtraJson,
  enrichTracerouteAsn,
  ingestTracerouteResultsBatch,
} from "./traceroute";
import { TRACEROUTE_EXTRA_JSON_MAX_BYTES } from "./util";

function makeAsnLookup(entries: Record<string, AsnInfo>): AsnLookup {
  return {
    lookup: (ip: string) => entries[ip] ?? null,
  };
}

const ASN_LOOKUP = makeAsnLookup({
  "203.0.113.1": { asn: 749, name: "DISA" },
  "203.0.113.2": { asn: 6939, name: "HURRICANE" },
  "203.0.113.9": { asn: 4837, name: "CHINA-UNICOM" },
  "8.8.8.8": { asn: 15169, name: "GOOGLE" },
});

function v1Extra(overrides: Record<string, unknown> = {}) {
  return {
    kind: "traceroute",
    v: 1,
    target: "example.com",
    target_ip: "8.8.8.8",
    origin_ip: "10.0.0.1",
    destination_asn_info: null,
    hops: [
      { ttl: 1, responses: [{ ip: "203.0.113.1", hostname: null, asn_info: null }], timeouts: 0 },
      { ttl: 2, responses: [{ ip: "203.0.113.2", hostname: null, asn_info: null }], timeouts: 0 },
    ],
    ...overrides,
  };
}

function v2Extra(overrides: Record<string, unknown> = {}) {
  return {
    kind: "traceroute",
    v: 2,
    target: "example.com",
    target_ip: "8.8.8.8",
    origin_ip: "10.0.0.1",
    destination_asn_info: null,
    protocol_used: "tcp",
    port: 443,
    traces: [
      {
        packet_size_bytes: 64,
        destination_reached: true,
        hops: [
          {
            ttl: 1,
            responses: [{ ip: "203.0.113.1", hostname: null, asn_info: null }],
            timeouts: 0,
          },
          {
            ttl: 2,
            responses: [{ ip: "203.0.113.9", hostname: null, asn_info: null }],
            timeouts: 0,
          },
        ],
      },
      {
        packet_size_bytes: 1400,
        destination_reached: true,
        hops: [
          {
            ttl: 1,
            responses: [{ ip: "203.0.113.1", hostname: null, asn_info: null }],
            timeouts: 0,
          },
          {
            ttl: 2,
            responses: [{ ip: "203.0.113.2", hostname: null, asn_info: null }],
            timeouts: 0,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("enrichTracerouteAsn", () => {
  test("v1: fills in missing hop asn_info from the lookup", () => {
    const out = JSON.parse(enrichTracerouteAsn(JSON.stringify(v1Extra()), ASN_LOOKUP));
    expect(out.hops[0].responses[0].asn_info).toEqual({
      asn: 749,
      prefix: "",
      country_code: "",
      registry: "",
      name: "DISA",
    });
    expect(out.hops[1].responses[0].asn_info.asn).toBe(6939);
  });

  test("v1: backfills top-level destination_asn_info from target_ip", () => {
    const out = JSON.parse(enrichTracerouteAsn(JSON.stringify(v1Extra()), ASN_LOOKUP));
    expect(out.destination_asn_info).toEqual({
      asn: 15169,
      prefix: "",
      country_code: "",
      registry: "",
      name: "GOOGLE",
    });
  });

  test("v1: does not overwrite an already-populated asn_info", () => {
    const extra = v1Extra();
    (extra.hops[0]!.responses[0] as { asn_info: unknown }).asn_info = { asn: 999, name: "STALE" };
    const out = JSON.parse(enrichTracerouteAsn(JSON.stringify(extra), ASN_LOOKUP));
    expect(out.hops[0].responses[0].asn_info).toEqual({ asn: 999, name: "STALE" });
  });

  test("v2: fills in missing asn_info across every trace's hops", () => {
    const out = JSON.parse(enrichTracerouteAsn(JSON.stringify(v2Extra()), ASN_LOOKUP));
    expect(out.traces[0].hops[0].responses[0].asn_info.asn).toBe(749);
    expect(out.traces[0].hops[1].responses[0].asn_info.asn).toBe(4837);
    expect(out.traces[1].hops[0].responses[0].asn_info.asn).toBe(749);
    expect(out.traces[1].hops[1].responses[0].asn_info.asn).toBe(6939);
  });

  test("v2: destination ASN stays top-level, not duplicated per trace", () => {
    const out = JSON.parse(enrichTracerouteAsn(JSON.stringify(v2Extra()), ASN_LOOKUP));
    expect(out.destination_asn_info.asn).toBe(15169);
    expect(out.traces[0].destination_asn_info).toBeUndefined();
  });

  test("leaves non-traceroute or malformed JSON untouched", () => {
    const notTraceroute = JSON.stringify({ kind: "icmp", hops: [] });
    expect(enrichTracerouteAsn(notTraceroute, ASN_LOOKUP)).toBe(notTraceroute);

    const malformed = "{not json";
    expect(enrichTracerouteAsn(malformed, ASN_LOOKUP)).toBe(malformed);
  });

  test("returns the exact same string reference when nothing needs enrichment", () => {
    const extra = {
      kind: "traceroute",
      v: 1,
      target_ip: "8.8.8.8",
      destination_asn_info: { asn: 15169, name: "GOOGLE" },
      hops: [{ ttl: 1, responses: [{ ip: "203.0.113.1", asn_info: { asn: 749, name: "DISA" } }] }],
    };
    const json = JSON.stringify(extra);
    expect(enrichTracerouteAsn(json, ASN_LOOKUP)).toBe(json);
  });
});

describe("buildTracerouteResultExtraJson", () => {
  test("returns null when x is undefined", () => {
    expect(buildTracerouteResultExtraJson(undefined, ASN_LOOKUP)).toBeNull();
  });

  test("returns enriched, parseable JSON for a normal-sized v1 result", () => {
    const json = buildTracerouteResultExtraJson(v1Extra(), ASN_LOOKUP);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!);
    expect(parsed.hops[0].responses[0].asn_info.asn).toBe(749);
  });

  test("returns enriched, parseable JSON for a normal-sized v2 result", () => {
    const json = buildTracerouteResultExtraJson(v2Extra(), ASN_LOOKUP);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!);
    expect(parsed.traces[0].hops[0].responses[0].asn_info.asn).toBe(749);
  });

  test("skips enrichment but still serializes when asnLookup is null", () => {
    const json = buildTracerouteResultExtraJson(v1Extra(), null);
    const parsed = JSON.parse(json!);
    expect(parsed.hops[0].responses[0].asn_info).toBeNull();
  });

  test("replaces an oversized v1 result with a small, valid result_too_large error", () => {
    const huge = v1Extra({ filler: "x".repeat(TRACEROUTE_EXTRA_JSON_MAX_BYTES + 1) });
    const json = buildTracerouteResultExtraJson(huge, ASN_LOOKUP);
    expect(json).not.toBeNull();

    // Must always be valid, parseable JSON — never a truncated fragment.
    const parsed = JSON.parse(json!);
    expect(parsed).toEqual({ kind: "traceroute", v: 1, error_code: "result_too_large" });
    expect(Buffer.byteLength(json!, "utf8")).toBeLessThan(TRACEROUTE_EXTRA_JSON_MAX_BYTES);
  });

  test("replaces an oversized v2 result with a small, valid result_too_large error tagged v2", () => {
    const huge = v2Extra({ filler: "x".repeat(TRACEROUTE_EXTRA_JSON_MAX_BYTES + 1) });
    const json = buildTracerouteResultExtraJson(huge, ASN_LOOKUP);
    const parsed = JSON.parse(json!);
    expect(parsed).toEqual({ kind: "traceroute", v: 2, error_code: "result_too_large" });
  });

  test("size check runs even without an asnLookup", () => {
    const huge = v1Extra({ filler: "x".repeat(TRACEROUTE_EXTRA_JSON_MAX_BYTES + 1) });
    const json = buildTracerouteResultExtraJson(huge, null);
    const parsed = JSON.parse(json!);
    expect(parsed.error_code).toBe("result_too_large");
  });

  test("stays at the byte cap boundary without tripping into the error path", () => {
    // Build a payload whose serialized size is deliberately right at the
    // limit to make sure the comparison is inclusive (`<=`), not off-by-one.
    const base = v1Extra();
    const baseLen = Buffer.byteLength(JSON.stringify(base), "utf8");
    const pad = "x".repeat(Math.max(0, TRACEROUTE_EXTRA_JSON_MAX_BYTES - baseLen - 12));
    const atLimit = v1Extra({ filler: pad });
    const json = buildTracerouteResultExtraJson(atLimit, null)!;
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(TRACEROUTE_EXTRA_JSON_MAX_BYTES);
    expect(JSON.parse(json).error_code).toBeUndefined();
  });
});

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedAgentAndTask(db: DbClient, agentId: string, taskId: string) {
  const nowMs = 1_700_000_000_000;
  await db.insert(schema.agent).values({
    id: agentId,
    tokenHash: `hash-${agentId}`,
    name: agentId,
    isPublic: true,
    displayOrder: 0,
    tagsJson: "[]",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await db.insert(schema.probeTask).values({
    id: taskId,
    name: taskId,
    kind: "traceroute",
    targetJson: JSON.stringify({ host: "example.com" }),
    intervalSec: 60,
    timeoutMs: 65_000,
    enabled: true,
    allAgents: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

async function seedAgentWithTasks(db: DbClient, agentId: string, taskIds: string[]) {
  const nowMs = 1_700_000_000_000;
  await db.insert(schema.agent).values({
    id: agentId,
    tokenHash: `hash-${agentId}`,
    name: agentId,
    isPublic: true,
    displayOrder: 0,
    tagsJson: "[]",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  // Chunk the seed insert so the fixture itself stays clear of
  // SQLITE_MAX_VARIABLE_NUMBER for large pair counts.
  for (let i = 0; i < taskIds.length; i += 200) {
    const rows = taskIds.slice(i, i + 200).map((taskId) => ({
      id: taskId,
      name: taskId,
      kind: "traceroute",
      targetJson: JSON.stringify({ host: "example.com" }),
      intervalSec: 60,
      timeoutMs: 65_000,
      enabled: true,
      allAgents: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    }));
    await db.insert(schema.probeTask).values(rows);
  }
}

function resultArgs(
  agentId: string,
  taskId: string,
  x: unknown,
  overrides: Partial<ProbeResultBody> = {},
) {
  return {
    agentId,
    recvTsMs: 1_700_000_000_500,
    result: {
      tid: taskId,
      ts: 1_700_000_000_000,
      ok: true,
      x,
      ...overrides,
    } satisfies ProbeResultBody,
  };
}

describe("ingestTracerouteResultsBatch (DB integration)", () => {
  let db: DbClient;
  let sqlite: Database;

  beforeEach(() => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
  });
  afterEach(() => sqlite.close());

  test("persists ASN-enriched v2 extra_json and a smaller-trace route signature", async () => {
    await seedAgentAndTask(db, "a1", "t1");

    await db.transaction((tx) =>
      ingestTracerouteResultsBatch(tx, [resultArgs("a1", "t1", v2Extra())], ASN_LOOKUP),
    );

    const [row] = await db.select().from(schema.probeResultLatest);
    expect(row).toBeDefined();
    const extra = JSON.parse(row!.extraJson!);
    expect(extra.traces[0].hops[0].responses[0].asn_info.asn).toBe(749);
    // Smaller trace (64 bytes) is [749, 4837]; larger trace is [749, 6939].
    expect(row!.routeObservationSignature).toBe("749,4837");
  });

  test("stores a structured result_too_large error instead of truncated JSON when oversized", async () => {
    await seedAgentAndTask(db, "a1", "t1");
    const huge = v2Extra({ filler: "x".repeat(TRACEROUTE_EXTRA_JSON_MAX_BYTES + 1) });

    await db.transaction((tx) =>
      ingestTracerouteResultsBatch(tx, [resultArgs("a1", "t1", huge)], ASN_LOOKUP),
    );

    const [row] = await db.select().from(schema.probeResultLatest);
    expect(row?.extraJson).not.toBeNull();
    // Must parse cleanly — this is the whole point of not truncating.
    expect(() => JSON.parse(row!.extraJson!)).not.toThrow();
    expect(JSON.parse(row!.extraJson!)).toEqual({
      kind: "traceroute",
      v: 2,
      error_code: "result_too_large",
    });
    expect(row!.routeObservationSignature).toBeNull();
  });

  test("ingests 1000+ unique pairs in one batch without tripping the expr-depth limit", async () => {
    // Deliberately above SQLITE_MAX_EXPR_DEPTH (~999 OR terms) and spanning
    // several ROUTE_STATE_CHUNK_SIZE (300) chunks. Before chunking, the flat
    // `or(...)` in batchLoadRouteStates threw here and rolled back the whole
    // shared ingest transaction.
    const PAIR_COUNT = 1200;
    const taskIds = Array.from({ length: PAIR_COUNT }, (_, i) => `t${i}`);
    await seedAgentWithTasks(db, "a1", taskIds);

    const batch = taskIds.map((taskId) => resultArgs("a1", taskId, v2Extra()));

    await db.transaction((tx) => ingestTracerouteResultsBatch(tx, batch, ASN_LOOKUP));

    const latest = await db.select().from(schema.probeResultLatest);
    expect(latest.length).toBe(PAIR_COUNT);
    const states = await db.select().from(schema.routeChangeState);
    expect(states.length).toBe(PAIR_COUNT);
  });

  test("loads prior per-pair state across chunks so confirmations survive re-ingest", async () => {
    const PAIR_COUNT = 1200;
    const taskIds = Array.from({ length: PAIR_COUNT }, (_, i) => `t${i}`);
    await seedAgentWithTasks(db, "a1", taskIds);

    const t1 = 1_700_000_000_000;
    const t2 = t1 + 60_000;

    // First sighting: each pair holds a single-seen candidate, not yet stable.
    await db.transaction((tx) =>
      ingestTracerouteResultsBatch(
        tx,
        taskIds.map((taskId) => resultArgs("a1", taskId, v2Extra(), { ts: t1 })),
        ASN_LOOKUP,
      ),
    );

    // Second identical sighting at a later ts. The candidate only reaches
    // confirmCount (and promotes to stable) if batchLoadRouteStates read the
    // first-round state back across every chunk. If a chunk were missed, that
    // pair would restart from empty and never leave the candidate stage.
    await db.transaction((tx) =>
      ingestTracerouteResultsBatch(
        tx,
        taskIds.map((taskId) => resultArgs("a1", taskId, v2Extra(), { ts: t2 })),
        ASN_LOOKUP,
      ),
    );

    const states = await db.select().from(schema.routeChangeState);
    expect(states.length).toBe(PAIR_COUNT);
    // Sample pairs drawn from distinct chunks (chunk size 300).
    for (const taskId of ["t0", "t400", "t900", "t1199"]) {
      const row = states.find((s) => s.taskId === taskId);
      expect(row).toBeDefined();
      expect(row!.stableSignature).toBe("749,4837");
      expect(row!.candidateSignature).toBeNull();
    }
  });
});
