import { asc, eq, inArray, max, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { findOrCreateGroupId, pruneUnusedAgentGroup } from "../../agents/groups";
import type { AppContext } from "../../app";
import {
  normalizeBillingConfig,
  parseBillingMode,
  parseQuotaBytes,
  parseResetDay,
  type BillingConfig,
} from "../../billing/billing";
import {
  agent,
  agentBilling,
  agentGroup,
  agentPricing,
  agentStatus,
  alertNotification,
  alertState,
  probeResultLatest,
  probeTask,
} from "../../db/schema";
import { createLogger } from "../../logging/logger";
import { sha256Hex } from "../../util/hash";
import { randomAgentToken } from "../../util/random";
import { parsePricingRecord, type AgentPricingWire } from "../helpers";
import {
  escapeLike,
  isRecord,
  MAX_NAME_LEN,
  MAX_NOTE_LEN,
  parseAgentTags,
  parseBoolQuery,
  parseCsvQuery,
  parsePageQuery,
  safeJsonParse,
} from "./parsing";
import { getProbeDispatcher } from "./shared";

const adminLog = createLogger("admin");

export function registerAdminAgentsRoutes(router: Hono<AppContext>) {
  router.get("/agents", async (c) => {
    const registry = c.get("registry");

    await registry.syncFromDbIfStale();

    const q = (c.req.query("q") ?? "").trim();
    const groupId = (c.req.query("groupId") ?? "").trim();
    const groupName = (c.req.query("groupName") ?? "").trim();
    const isPublic = parseBoolQuery(c.req.query("public"));
    const online = parseBoolQuery(c.req.query("online"));
    const overQuota = parseBoolQuery(c.req.query("overQuota"));

    const tagFilters = [
      ...parseCsvQuery(c.req.query("tag")),
      ...parseCsvQuery(c.req.query("tags")),
    ];

    let agents = registry.listAdminSummaries({
      q: q || undefined,
      groupId: groupId || undefined,
      groupName: groupName || undefined,
      isPublic: isPublic ?? undefined,
      online: online ?? undefined,
      tags: tagFilters.length > 0 ? tagFilters : undefined,
    });

    if (overQuota === true) agents = agents.filter((a) => a.billing.overQuota);
    else if (overQuota === false) agents = agents.filter((a) => !a.billing.overQuota);

    const { limit, offset } = parsePageQuery({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    const total = agents.length;
    const page = agents.slice(offset, offset + limit);

    return c.json({ total, limit, offset, agents: page });
  });

  router.get("/agents/options", async (c) => {
    const registry = c.get("registry");
    await registry.syncFromDbIfStale();
    return c.json({ agents: registry.listOptionRefs() });
  });

  router.get("/agents/:agentId", async (c) => {
    const registry = c.get("registry");
    const agentId = c.req.param("agentId");

    // Covers the same CLI-created-before-hello case as the list handler.
    await registry.ensureAgent(agentId);

    const detail = registry.getAdminDetail(agentId);
    if (!detail) return c.json({ code: "not_found" }, 404);
    return c.json(detail);
  });

  router.post("/agents", async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (!name) return c.json({ code: "missing_name" }, 400);
    if (name.length > MAX_NAME_LEN) return c.json({ code: "name_too_long" }, 400);

    const isPublic = typeof body["isPublic"] === "boolean" ? body["isPublic"] : false;
    const token =
      typeof body["token"] === "string" && body["token"].trim()
        ? body["token"].trim()
        : randomAgentToken(32);
    const tags = body["tags"] !== undefined ? parseAgentTags(body["tags"]) : [];
    if (tags === null) return c.json({ code: "invalid_tags" }, 400);
    const note = typeof body["note"] === "string" ? body["note"] : null;
    if (note !== null && note.length > MAX_NOTE_LEN) return c.json({ code: "note_too_long" }, 400);

    let pricingValues: AgentPricingWire | undefined;
    if (isRecord(body["pricing"])) {
      const parsedPricing = parsePricingRecord(body["pricing"]);
      if (!parsedPricing) return c.json({ code: "invalid_pricing" }, 400);
      pricingValues = parsedPricing;
    }

    const nowMs = Date.now();
    const agentId = crypto.randomUUID();
    const tokenHash = sha256Hex(token);

    let groupName: string | null = null;
    if (body["groupName"] !== undefined && body["groupName"] !== null) {
      if (typeof body["groupName"] !== "string") return c.json({ code: "invalid_group" }, 400);
      const rawName = body["groupName"].trim();
      if (!rawName) return c.json({ code: "invalid_group" }, 400);
      if (rawName.length > MAX_NAME_LEN) return c.json({ code: "group_name_too_long" }, 400);
      groupName = rawName;
    }

    const billingConfig: BillingConfig = { quotaBytes: 0, mode: "sum", resetDay: 1 };
    let displayOrder = 0;
    let groupId: string | null = null;

    await db.transaction(async (tx) => {
      if (groupName) {
        groupId = await findOrCreateGroupId(tx, groupName, nowMs);
      }

      const [{ maxOrder }] = await tx.select({ maxOrder: max(agent.displayOrder) }).from(agent);
      displayOrder = (maxOrder ?? -1) + 1;

      await tx.insert(agent).values({
        id: agentId,
        tokenHash,
        name,
        groupId,
        isPublic,
        tagsJson: JSON.stringify(tags),
        note,
        displayOrder,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });

      await tx.insert(agentStatus).values({
        agentId,
        online: false,
        updatedAtMs: nowMs,
      });

      await tx.insert(agentBilling).values({
        agentId,
        quotaBytes: billingConfig.quotaBytes,
        mode: billingConfig.mode,
        resetDay: billingConfig.resetDay,
        updatedAtMs: nowMs,
      });

      if (pricingValues) {
        await tx.insert(agentPricing).values({
          agentId,
          ...pricingValues,
          updatedAtMs: nowMs,
        });
      }
    });

    await registry.runUnderPatchLock(agentId, async () => {
      if (registry.has(agentId)) return;
      registry.insert({
        id: agentId,
        name,
        isPublic,
        displayOrder,
        groupId,
        groupName,
        tags,
        note,
        billingConfig,
        pricing: pricingValues ?? null,
        nowMs,
      });
    });
    c.get("liveHub")?.publishAgentChanges([agentId]);

    adminLog.info(`agent created: name=${name} id=${agentId}`);
    return c.json({ ok: true, id: agentId, token });
  });

  router.patch("/agents/:agentId", async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    const agentId = c.req.param("agentId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const nowMs = Date.now();

    // `ensureAgent` (not `has`) so CLI-created agents created after boot are
    // also reachable — mirrors the GET detail handler above.
    if (!(await registry.ensureAgent(agentId))) return c.json({ code: "not_found" }, 404);

    const patch: Partial<typeof agent.$inferInsert> = {};
    let nextName: string | undefined;
    let nextIsPublic: boolean | undefined;
    let nextNote: string | null | undefined;
    let nextTags: string[] | undefined;

    if (typeof body["name"] === "string") {
      const v = body["name"].trim();
      if (!v) return c.json({ code: "invalid_name" }, 400);
      if (v.length > MAX_NAME_LEN) return c.json({ code: "name_too_long" }, 400);
      patch.name = v;
      nextName = v;
    }
    if (typeof body["isPublic"] === "boolean") {
      patch.isPublic = body["isPublic"];
      nextIsPublic = body["isPublic"];
    }
    if (body["note"] === null || typeof body["note"] === "string") {
      if (typeof body["note"] === "string" && body["note"].length > MAX_NOTE_LEN) {
        return c.json({ code: "note_too_long" }, 400);
      }
      patch.note = body["note"];
      nextNote = body["note"];
    }
    if (body["tags"] !== undefined) {
      const tags = parseAgentTags(body["tags"]);
      if (tags === null) return c.json({ code: "invalid_tags" }, 400);
      patch.tagsJson = JSON.stringify(tags);
      nextTags = tags;
    }

    let billingNext: BillingConfig | undefined;
    if (isRecord(body["billing"])) {
      const b = body["billing"];
      const quotaBytes =
        b["quotaBytes"] === undefined ? undefined : parseQuotaBytes(b["quotaBytes"]);
      if (quotaBytes === null) return c.json({ code: "invalid_quota_bytes" }, 400);

      const bMode = b["mode"] === undefined ? undefined : parseBillingMode(b["mode"]);
      if (bMode === null) return c.json({ code: "invalid_mode" }, 400);

      const bResetDay = b["resetDay"] === undefined ? undefined : parseResetDay(b["resetDay"]);
      if (bResetDay === null) return c.json({ code: "invalid_reset_day" }, 400);

      if (quotaBytes !== undefined && bMode !== undefined && bResetDay !== undefined) {
        billingNext = { quotaBytes, mode: bMode, resetDay: bResetDay };
      } else {
        const currentRows = await db
          .select({
            quotaBytes: agentBilling.quotaBytes,
            mode: agentBilling.mode,
            resetDay: agentBilling.resetDay,
          })
          .from(agentBilling)
          .where(eq(agentBilling.agentId, agentId))
          .limit(1);

        const current = normalizeBillingConfig({
          quotaBytes: currentRows[0]?.quotaBytes ?? undefined,
          mode: currentRows[0]?.mode ?? undefined,
          resetDay: currentRows[0]?.resetDay ?? undefined,
        });

        billingNext = {
          quotaBytes: quotaBytes ?? current.quotaBytes,
          mode: bMode ?? current.mode,
          resetDay: bResetDay ?? current.resetDay,
        };
      }
    }

    type GroupInput = { kind: "clear" } | { kind: "set"; name: string };
    let groupInput: GroupInput | undefined;
    if (body["groupName"] !== undefined) {
      if (body["groupName"] === null) {
        groupInput = { kind: "clear" };
      } else if (typeof body["groupName"] === "string") {
        const raw = body["groupName"].trim();
        if (!raw) return c.json({ code: "invalid_group" }, 400);
        if (raw.length > MAX_NAME_LEN) return c.json({ code: "group_name_too_long" }, 400);
        groupInput = { kind: "set", name: raw };
      } else {
        return c.json({ code: "invalid_group" }, 400);
      }
    }

    patch.updatedAtMs = nowMs;

    let pricingPatch: AgentPricingWire | "delete" | undefined;
    if (body["pricing"] === null) {
      pricingPatch = "delete";
    } else if (isRecord(body["pricing"])) {
      const parsedPricing = parsePricingRecord(body["pricing"]);
      if (!parsedPricing) return c.json({ code: "invalid_pricing" }, 400);
      pricingPatch = parsedPricing;
    }

    // Resolved inside the tx so we read the real previous groupId from the DB
    // (not from registry memory, which can drift) and so findOrCreateGroupId is
    // not racing with concurrent prunes between two separate calls.
    let groupChanged = false;
    let resolvedGroupPatch: { groupId: string | null; groupName: string | null } | undefined;

    const runDbWrite = async () => {
      await db.transaction(async (tx) => {
        let prevGroupId: string | null = null;
        if (groupInput !== undefined) {
          const [row] = await tx
            .select({ groupId: agent.groupId })
            .from(agent)
            .where(eq(agent.id, agentId))
            .limit(1);
          prevGroupId = row?.groupId ?? null;
          const nextGroupId =
            groupInput.kind === "set"
              ? await findOrCreateGroupId(tx, groupInput.name, nowMs)
              : null;
          patch.groupId = nextGroupId;
          groupChanged = nextGroupId !== prevGroupId;
          resolvedGroupPatch = {
            groupId: nextGroupId,
            groupName: groupInput.kind === "set" ? groupInput.name : null,
          };
        }

        await tx.update(agent).set(patch).where(eq(agent.id, agentId));

        if (billingNext) {
          const billing = billingNext;
          await tx
            .insert(agentBilling)
            .values({
              agentId,
              quotaBytes: billing.quotaBytes,
              mode: billing.mode,
              resetDay: billing.resetDay,
              updatedAtMs: nowMs,
            })
            .onConflictDoUpdate({
              target: agentBilling.agentId,
              set: {
                quotaBytes: billing.quotaBytes,
                mode: billing.mode,
                resetDay: billing.resetDay,
                updatedAtMs: nowMs,
              },
            });
        }
        if (pricingPatch === "delete") {
          await tx.delete(agentPricing).where(eq(agentPricing.agentId, agentId));
        } else if (pricingPatch) {
          await tx
            .insert(agentPricing)
            .values({ agentId, ...pricingPatch, updatedAtMs: nowMs })
            .onConflictDoUpdate({
              target: agentPricing.agentId,
              set: { ...pricingPatch, updatedAtMs: nowMs },
            });
        }
        if (groupChanged) {
          await pruneUnusedAgentGroup(tx, prevGroupId);
        }
      });
      return resolvedGroupPatch;
    };

    // group fields are intentionally absent from the patch passed to
    // patchWithDb: their real values come from the tx and are applied to the
    // registry only after the tx commits.
    const applied = await registry.patchWithDb(
      agentId,
      {
        name: nextName,
        isPublic: nextIsPublic,
        note: nextNote,
        tags: nextTags,
        billingConfig: billingNext,
        pricing: pricingPatch,
      },
      runDbWrite,
    );
    if (!applied) return c.json({ code: "not_found" }, 404);

    c.get("liveHub")?.publishAgentChanges([agentId]);
    if (groupChanged) {
      getProbeDispatcher(c)
        ?.pushAgent(agentId)
        .catch((err) => adminLog.error(`post-group-change pushAgent failed: id=${agentId}`, err));
    }

    return c.json({ ok: true });
  });

  router.post("/agents/:agentId/rotate-token", async (c) => {
    const db = c.get("db");
    const dispatcher = getProbeDispatcher(c);
    const agentId = c.req.param("agentId");

    const exists = await db
      .select({ id: agent.id })
      .from(agent)
      .where(eq(agent.id, agentId))
      .limit(1);
    if (exists.length === 0) return c.json({ code: "not_found" }, 404);

    const token = randomAgentToken(32);
    const tokenHash = sha256Hex(token);

    await db.update(agent).set({ tokenHash, updatedAtMs: Date.now() }).where(eq(agent.id, agentId));

    try {
      await dispatcher?.revokeAgent(agentId);
    } catch (err) {
      adminLog.error(`post-rotate revokeAgent failed: id=${agentId}`, err);
    }

    return c.json({ ok: true, token });
  });

  router.delete("/agents/:agentId", async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    const dispatcher = getProbeDispatcher(c);
    const agentId = c.req.param("agentId");

    if (dispatcher) await dispatcher.quiesceAgent(agentId);

    const subjectKey = `a:${agentId}`;
    const subjectKeyTaskPrefix = `a:${escapeLike(agentId)}|%`;

    const deleted = await registry.runUnderPatchLock(agentId, async () => {
      const deletedAgents = await db.transaction(async (tx) => {
        const rows = await tx
          .delete(agent)
          .where(eq(agent.id, agentId))
          .returning({ id: agent.id, groupId: agent.groupId });
        if (rows.length === 0) return rows;

        await pruneUnusedAgentGroup(tx, rows[0]!.groupId ?? null);

        await tx
          .delete(alertState)
          .where(
            or(
              eq(alertState.subjectKey, subjectKey),
              sql`${alertState.subjectKey} LIKE ${subjectKeyTaskPrefix} ESCAPE '!'`,
            ),
          );
        await tx
          .delete(alertNotification)
          .where(
            or(
              eq(alertNotification.subjectKey, subjectKey),
              sql`${alertNotification.subjectKey} LIKE ${subjectKeyTaskPrefix} ESCAPE '!'`,
            ),
          );
        return rows;
      });
      if (deletedAgents.length > 0) registry.remove(agentId);
      return deletedAgents;
    });

    if (deleted.length === 0) return c.json({ code: "not_found" }, 404);

    c.get("liveHub")?.publishAgentChanges([agentId]);

    try {
      await dispatcher?.revokeAgent(agentId);
    } catch (err) {
      adminLog.error(`post-commit revokeAgent failed: id=${agentId}`, err);
    }

    adminLog.info(`agent deleted: id=${agentId}`);
    return c.json({ ok: true });
  });

  router.put("/agents/reorder", async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const agentIds = body["agentIds"];
    if (!Array.isArray(agentIds) || !agentIds.every((id) => typeof id === "string")) {
      return c.json({ code: "invalid_agent_ids" }, 400);
    }

    if (agentIds.length === 0) return c.json({ ok: true });
    if (new Set(agentIds).size !== agentIds.length) {
      return c.json({ code: "duplicate_agent_ids" }, 400);
    }

    const nowMs = Date.now();
    const cases = agentIds.map((id, i) => sql`WHEN ${id} THEN ${i}`);

    // Reorder rewrites displayOrder to 0..N-1 over the supplied set; if the caller
    // sends a partial or fabricated subset (filtered UI bypassed, hand-rolled request),
    // un-supplied rows keep their old order and we'd end up with duplicates / silent
    // no-ops. Require an exact bijection with the full table — count + membership
    // checks live in the same tx as the update so concurrent inserts can't slip in.
    const result = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: agent.id }).from(agent);
      const total = existing.length;
      if (agentIds.length !== total) {
        return { ok: false as const, expected: total };
      }
      const known = new Set(existing.map((r) => r.id));
      for (const id of agentIds) {
        if (!known.has(id)) return { ok: false as const, expected: total };
      }
      await tx
        .update(agent)
        .set({
          displayOrder: sql`CASE ${agent.id} ${sql.join(cases, sql` `)} END`,
          updatedAtMs: nowMs,
        })
        .where(inArray(agent.id, agentIds));
      return { ok: true as const };
    });

    if (!result.ok) {
      return c.json(
        { code: "incomplete_set", expected: result.expected, got: agentIds.length },
        400,
      );
    }

    registry.reorder(agentIds);
    c.get("liveHub")?.publishAgentChanges(agentIds);

    return c.json({ ok: true });
  });

  router.get("/groups", async (c) => {
    const db = c.get("db");
    const rows = await db
      .select({ id: agentGroup.id, name: agentGroup.name })
      .from(agentGroup)
      .orderBy(asc(agentGroup.name));
    return c.json({ groups: rows });
  });

  router.get("/agents/:agentId/probe-latest", async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    const agentId = c.req.param("agentId");

    if (!(await registry.ensureAgent(agentId))) return c.json({ code: "not_found" }, 404);

    const rows = await db
      .select({
        taskId: probeResultLatest.taskId,
        tsMs: probeResultLatest.tsMs,
        recvTsMs: probeResultLatest.recvTsMs,
        ok: probeResultLatest.ok,
        latMs: probeResultLatest.latMs,
        code: probeResultLatest.code,
        err: probeResultLatest.err,
        extraJson: probeResultLatest.extraJson,
        lossPct: probeResultLatest.lossPct,
        jitterMs: probeResultLatest.jitterMs,
        updatedAtMs: probeResultLatest.updatedAtMs,
        taskName: probeTask.name,
        taskKind: probeTask.kind,
        taskEnabled: probeTask.enabled,
        taskIntervalSec: probeTask.intervalSec,
        taskTimeoutMs: probeTask.timeoutMs,
        taskTargetJson: probeTask.targetJson,
      })
      .from(probeResultLatest)
      .leftJoin(probeTask, eq(probeResultLatest.taskId, probeTask.id))
      .where(eq(probeResultLatest.agentId, agentId))
      .orderBy(asc(probeTask.name));

    return c.json({
      agentId,
      results: rows.map((r) => ({
        task: {
          id: r.taskId,
          name: r.taskName ?? null,
          kind: r.taskKind ?? null,
          enabled: r.taskEnabled ?? null,
          intervalSec: r.taskIntervalSec ?? null,
          timeoutMs: r.taskTimeoutMs ?? null,
          target: r.taskTargetJson ? safeJsonParse(r.taskTargetJson) : null,
        },
        latest: {
          tsMs: r.tsMs,
          recvTsMs: r.recvTsMs,
          ok: r.ok,
          latMs: r.latMs ?? null,
          code: r.code ?? null,
          err: r.err ?? null,
          extra: r.extraJson ? safeJsonParse(r.extraJson) : null,
          lossPct: r.lossPct ?? null,
          jitterMs: r.jitterMs ?? null,
          updatedAtMs: r.updatedAtMs,
        },
      })),
    });
  });
}
