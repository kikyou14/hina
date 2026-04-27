import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { pruneUnusedAgentGroups } from "../../agents/groups";
import type { AppContext } from "../../app";
import {
  agent,
  agentGroup,
  alertNotification,
  alertState,
  probeTask,
  probeTaskAgent,
  probeTaskGroup,
} from "../../db/schema";
import {
  isRecord,
  MAX_NAME_LEN,
  parseBoolQuery,
  parseIntervalSec,
  parsePageQuery,
  parseProbeKind,
  parseStringArray,
  escapeLike,
  parseTarget,
  parseTimeoutMs,
  safeJsonParse,
  uniqueStrings,
} from "./parsing";
import { getProbeDispatcher } from "./shared";

export function registerAdminProbeTaskRoutes(router: Hono<AppContext>) {
  router.get("/probe-tasks", async (c) => {
    const db = c.get("db");

    const q = (c.req.query("q") ?? "").trim();
    const kind = parseProbeKind(c.req.query("kind"));
    const enabled = parseBoolQuery(c.req.query("enabled"));
    const { limit, offset } = parsePageQuery({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });

    const conditions = [];
    if (q) conditions.push(sql`${probeTask.name} LIKE ${"%" + escapeLike(q) + "%"} ESCAPE '!'`);
    if (kind) conditions.push(eq(probeTask.kind, kind));
    if (enabled !== null) conditions.push(eq(probeTask.enabled, enabled));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Run count + page + scope joins in one read transaction so total/rows/joins
    // share a single SQLite snapshot under concurrent writes.
    const { total, tasks, groupLinks, agentLinks } = await db.transaction(async (tx) => {
      const totalRows = await tx
        .select({ n: sql<number>`count(*)` })
        .from(probeTask)
        .where(where);
      const total = Number(totalRows[0]?.n ?? 0);

      const tasks = await tx
        .select()
        .from(probeTask)
        .where(where)
        .orderBy(asc(probeTask.displayOrder), asc(probeTask.name), asc(probeTask.id))
        .limit(limit)
        .offset(offset);

      const taskIds = tasks.map((t) => t.id);

      const groupLinks = taskIds.length
        ? await tx
            .select({
              taskId: probeTaskGroup.taskId,
              groupId: agentGroup.id,
              groupName: agentGroup.name,
            })
            .from(probeTaskGroup)
            .innerJoin(agentGroup, eq(probeTaskGroup.groupId, agentGroup.id))
            .where(inArray(probeTaskGroup.taskId, taskIds))
            .orderBy(asc(agentGroup.name))
        : [];

      const agentLinks = taskIds.length
        ? await tx
            .select({
              taskId: probeTaskAgent.taskId,
              agentId: agent.id,
              agentName: agent.name,
            })
            .from(probeTaskAgent)
            .innerJoin(agent, eq(probeTaskAgent.agentId, agent.id))
            .where(inArray(probeTaskAgent.taskId, taskIds))
            .orderBy(asc(agent.name))
        : [];

      return { total, tasks, groupLinks, agentLinks };
    });

    const groupsByTaskId = new Map<string, { id: string; name: string }[]>();
    for (const l of groupLinks) {
      const list = groupsByTaskId.get(l.taskId) ?? [];
      list.push({ id: l.groupId, name: l.groupName });
      groupsByTaskId.set(l.taskId, list);
    }

    const agentsByTaskId = new Map<string, { id: string; name: string }[]>();
    for (const l of agentLinks) {
      const list = agentsByTaskId.get(l.taskId) ?? [];
      list.push({ id: l.agentId, name: l.agentName });
      agentsByTaskId.set(l.taskId, list);
    }

    return c.json({
      total,
      limit,
      offset,
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        enabled: t.enabled,
        allAgents: t.allAgents,
        traceRevealHopDetails: t.kind === "traceroute" ? t.traceRevealHopDetails : false,
        intervalSec: t.intervalSec,
        timeoutMs: t.timeoutMs,
        target: safeJsonParse(t.targetJson),
        createdAtMs: t.createdAtMs,
        updatedAtMs: t.updatedAtMs,
        groups: groupsByTaskId.get(t.id) ?? [],
        agents: agentsByTaskId.get(t.id) ?? [],
      })),
    });
  });

  router.get("/probe-tasks/options", async (c) => {
    const db = c.get("db");
    const tasks = await db
      .select({ id: probeTask.id, name: probeTask.name, kind: probeTask.kind })
      .from(probeTask)
      .orderBy(asc(probeTask.displayOrder), asc(probeTask.name), asc(probeTask.id));
    return c.json({ tasks });
  });

  router.post("/probe-tasks", async (c) => {
    const db = c.get("db");
    const dispatcher = getProbeDispatcher(c);

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

    const kind = parseProbeKind(body["kind"]);
    if (!kind) return c.json({ code: "invalid_kind" }, 400);

    const targetParsed = parseTarget(kind, body["target"]);
    if (!targetParsed) return c.json({ code: "invalid_target" }, 400);

    const intervalSec = parseIntervalSec(body["intervalSec"]);
    if (!intervalSec) return c.json({ code: "invalid_interval_sec" }, 400);

    const timeoutMs = parseTimeoutMs(body["timeoutMs"] ?? 5000);
    if (!timeoutMs) return c.json({ code: "invalid_timeout_ms" }, 400);

    const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : true;
    const allAgents = body["allAgents"] === true;
    const traceRevealHopDetails =
      kind === "traceroute" && typeof body["traceRevealHopDetails"] === "boolean"
        ? body["traceRevealHopDetails"]
        : false;

    const groupIds = allAgents ? [] : uniqueStrings(parseStringArray(body["groupIds"]));
    const agentIds = allAgents ? [] : uniqueStrings(parseStringArray(body["agentIds"]));

    if (!allAgents && groupIds.length === 0 && agentIds.length === 0) {
      return c.json({ code: "missing_scope" }, 400);
    }

    if (groupIds.length > 0) {
      const existing = await db
        .select({ id: agentGroup.id })
        .from(agentGroup)
        .where(inArray(agentGroup.id, groupIds));
      const set = new Set(existing.map((r) => r.id));
      const missing = groupIds.filter((id) => !set.has(id));
      if (missing.length > 0) return c.json({ code: "invalid_group_ids", missing }, 400);
    }

    if (agentIds.length > 0) {
      const existing = await db
        .select({ id: agent.id })
        .from(agent)
        .where(inArray(agent.id, agentIds));
      const set = new Set(existing.map((r) => r.id));
      const missing = agentIds.filter((id) => !set.has(id));
      if (missing.length > 0) return c.json({ code: "invalid_agent_ids", missing }, 400);
    }

    const nowMs = Date.now();
    const taskId = crypto.randomUUID();

    await db.transaction(async (tx) => {
      const [{ maxOrder }] = await tx
        .select({ maxOrder: max(probeTask.displayOrder) })
        .from(probeTask);
      const displayOrder = (maxOrder ?? -1) + 1;

      await tx.insert(probeTask).values({
        id: taskId,
        name,
        kind,
        targetJson: targetParsed.targetJson,
        intervalSec,
        timeoutMs,
        enabled,
        allAgents,
        traceRevealHopDetails,
        displayOrder,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });

      if (groupIds.length > 0) {
        await tx.insert(probeTaskGroup).values(
          groupIds.map((groupId) => ({
            taskId,
            groupId,
            createdAtMs: nowMs,
          })),
        );
      }
      if (agentIds.length > 0) {
        await tx.insert(probeTaskAgent).values(
          agentIds.map((agentId) => ({
            taskId,
            agentId,
            createdAtMs: nowMs,
          })),
        );
      }
    });

    dispatcher?.pushAll().catch((err) => console.error("probe pushAll failed", err));
    return c.json({ ok: true, id: taskId });
  });

  router.patch("/probe-tasks/:taskId", async (c) => {
    const db = c.get("db");
    const dispatcher = getProbeDispatcher(c);
    const taskId = c.req.param("taskId");

    const existingRows = await db
      .select({
        id: probeTask.id,
        kind: probeTask.kind,
        targetJson: probeTask.targetJson,
        allAgents: probeTask.allAgents,
      })
      .from(probeTask)
      .where(eq(probeTask.id, taskId))
      .limit(1);
    if (existingRows.length === 0) return c.json({ code: "not_found" }, 404);
    const existing = existingRows[0]!;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const patch: Record<string, unknown> = {};
    const kindInput = body["kind"] === undefined ? null : parseProbeKind(body["kind"]);
    if (body["kind"] !== undefined && !kindInput) return c.json({ code: "invalid_kind" }, 400);

    const kind = kindInput ?? parseProbeKind(existing.kind);
    if (!kind) return c.json({ code: "invalid_existing_kind" }, 500);

    if (typeof body["name"] === "string") {
      const v = body["name"].trim();
      if (!v) return c.json({ code: "invalid_name" }, 400);
      if (v.length > MAX_NAME_LEN) return c.json({ code: "name_too_long" }, 400);
      patch["name"] = v;
    }
    if (typeof body["enabled"] === "boolean") patch["enabled"] = body["enabled"];
    const nextAllAgents = typeof body["allAgents"] === "boolean" ? body["allAgents"] : null;
    if (nextAllAgents !== null) patch["allAgents"] = nextAllAgents;
    if (body["traceRevealHopDetails"] !== undefined) {
      if (typeof body["traceRevealHopDetails"] !== "boolean") {
        return c.json({ code: "invalid_trace_reveal_hop_details" }, 400);
      }
      patch["traceRevealHopDetails"] =
        kind === "traceroute" ? body["traceRevealHopDetails"] : false;
    } else if (kindInput && kind !== "traceroute") {
      patch["traceRevealHopDetails"] = false;
    }

    if (body["intervalSec"] !== undefined) {
      const v = parseIntervalSec(body["intervalSec"]);
      if (!v) return c.json({ code: "invalid_interval_sec" }, 400);
      patch["intervalSec"] = v;
    }

    if (body["timeoutMs"] !== undefined) {
      const v = parseTimeoutMs(body["timeoutMs"]);
      if (!v) return c.json({ code: "invalid_timeout_ms" }, 400);
      patch["timeoutMs"] = v;
    }

    if (body["target"] !== undefined) {
      const parsed = parseTarget(kind, body["target"]);
      if (!parsed) return c.json({ code: "invalid_target" }, 400);
      patch["targetJson"] = parsed.targetJson;
    } else if (kindInput) {
      return c.json({ code: "missing_target" }, 400);
    }

    if (kindInput) patch["kind"] = kindInput;

    const groupIdsRaw = body["groupIds"];
    const agentIdsRaw = body["agentIds"];

    const groupIds = nextAllAgents
      ? []
      : groupIdsRaw === undefined
        ? null
        : uniqueStrings(parseStringArray(groupIdsRaw));
    const agentIds = nextAllAgents
      ? []
      : agentIdsRaw === undefined
        ? null
        : uniqueStrings(parseStringArray(agentIdsRaw));

    if (groupIds !== null) {
      const existingGroups = groupIds.length
        ? await db
            .select({ id: agentGroup.id })
            .from(agentGroup)
            .where(inArray(agentGroup.id, groupIds))
        : [];
      const set = new Set(existingGroups.map((r) => r.id));
      const missing = groupIds.filter((id) => !set.has(id));
      if (missing.length > 0) return c.json({ code: "invalid_group_ids", missing }, 400);
    }

    if (agentIds !== null) {
      const existingAgents = agentIds.length
        ? await db.select({ id: agent.id }).from(agent).where(inArray(agent.id, agentIds))
        : [];
      const set = new Set(existingAgents.map((r) => r.id));
      const missing = agentIds.filter((id) => !set.has(id));
      if (missing.length > 0) return c.json({ code: "invalid_agent_ids", missing }, 400);
    }

    const effectiveAllAgents = nextAllAgents ?? existing.allAgents;
    if (!effectiveAllAgents) {
      if (nextAllAgents === false && groupIds === null && agentIds === null) {
        return c.json({ code: "missing_scope" }, 400);
      }
      if (
        groupIds !== null &&
        agentIds !== null &&
        groupIds.length === 0 &&
        agentIds.length === 0
      ) {
        return c.json({ code: "missing_scope" }, 400);
      }
    }

    const nowMs = Date.now();
    patch["updatedAtMs"] = nowMs;

    await db.transaction(async (tx) => {
      if (Object.keys(patch).length > 1) {
        await tx.update(probeTask).set(patch).where(eq(probeTask.id, taskId));
      } else {
        await tx.update(probeTask).set({ updatedAtMs: nowMs }).where(eq(probeTask.id, taskId));
      }

      let droppedGroupIds: string[] = [];
      if (nextAllAgents !== null || groupIds !== null) {
        const removed = await tx
          .delete(probeTaskGroup)
          .where(eq(probeTaskGroup.taskId, taskId))
          .returning({ groupId: probeTaskGroup.groupId });
        const newGroupIds = groupIds ?? [];
        if (newGroupIds.length > 0) {
          await tx.insert(probeTaskGroup).values(
            newGroupIds.map((groupId) => ({
              taskId,
              groupId,
              createdAtMs: nowMs,
            })),
          );
        }
        const kept = new Set(newGroupIds);
        droppedGroupIds = removed.map((r) => r.groupId).filter((id) => !kept.has(id));
      }

      if (nextAllAgents !== null || agentIds !== null) {
        await tx.delete(probeTaskAgent).where(eq(probeTaskAgent.taskId, taskId));
        if (agentIds && agentIds.length > 0) {
          await tx.insert(probeTaskAgent).values(
            agentIds.map((agentId) => ({
              taskId,
              agentId,
              createdAtMs: nowMs,
            })),
          );
        }
      }

      if (droppedGroupIds.length > 0) {
        await pruneUnusedAgentGroups(tx, droppedGroupIds);
      }
    });

    dispatcher?.pushAll().catch((err) => console.error("probe pushAll failed", err));
    return c.json({ ok: true });
  });

  router.put("/probe-tasks/reorder", async (c) => {
    const db = c.get("db");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const taskIds = body["taskIds"];
    if (!Array.isArray(taskIds) || !taskIds.every((id) => typeof id === "string")) {
      return c.json({ code: "invalid_task_ids" }, 400);
    }

    if (taskIds.length === 0) return c.json({ ok: true });
    if (new Set(taskIds).size !== taskIds.length) {
      return c.json({ code: "duplicate_task_ids" }, 400);
    }

    const nowMs = Date.now();
    const cases = taskIds.map((id, i) => sql`WHEN ${id} THEN ${i}`);

    // See routes-agents.ts /agents/reorder: require an exact bijection with the
    // full set, both length and membership, so a partial / forged payload can't
    // silently no-op (forged ids) or collide displayOrder (unsupplied rows).
    const result = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: probeTask.id }).from(probeTask);
      const total = existing.length;
      if (taskIds.length !== total) {
        return { ok: false as const, expected: total };
      }
      const known = new Set(existing.map((r) => r.id));
      for (const id of taskIds) {
        if (!known.has(id)) return { ok: false as const, expected: total };
      }
      await tx
        .update(probeTask)
        .set({
          displayOrder: sql`CASE ${probeTask.id} ${sql.join(cases, sql` `)} END`,
          updatedAtMs: nowMs,
        })
        .where(inArray(probeTask.id, taskIds));
      return { ok: true as const };
    });

    if (!result.ok) {
      return c.json(
        { code: "incomplete_set", expected: result.expected, got: taskIds.length },
        400,
      );
    }

    return c.json({ ok: true });
  });

  router.delete("/probe-tasks/:taskId", async (c) => {
    const db = c.get("db");
    const dispatcher = getProbeDispatcher(c);
    const taskId = c.req.param("taskId");

    const subjectKeyPattern = `%|t:${escapeLike(taskId)}`;
    const deleted = await db.transaction(async (tx) => {
      // Capture group links before the cascade wipes probe_task_group rows.
      const linkedGroupIds = await tx
        .select({ groupId: probeTaskGroup.groupId })
        .from(probeTaskGroup)
        .where(eq(probeTaskGroup.taskId, taskId));

      const rows = await tx
        .delete(probeTask)
        .where(eq(probeTask.id, taskId))
        .returning({ id: probeTask.id });
      if (rows.length === 0) return rows;

      await tx
        .delete(alertState)
        .where(sql`${alertState.subjectKey} LIKE ${subjectKeyPattern} ESCAPE '!'`);
      await tx
        .delete(alertNotification)
        .where(sql`${alertNotification.subjectKey} LIKE ${subjectKeyPattern} ESCAPE '!'`);

      await pruneUnusedAgentGroups(
        tx,
        linkedGroupIds.map((r) => r.groupId),
      );
      return rows;
    });
    if (deleted.length === 0) return c.json({ code: "not_found" }, 404);

    dispatcher?.pushAll().catch((err) => console.error("probe pushAll failed", err));
    return c.json({ ok: true });
  });
}
