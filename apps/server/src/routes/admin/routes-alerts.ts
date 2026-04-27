import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";

import { pruneUnusedAgentGroups } from "../../agents/groups";
import { resolveNotifier } from "../../alert/channels/registry";
import { buildSampleMessage } from "../../alert/message/builder";
import { formatValueSummary } from "../../alert/message/vars";
import {
  parseAlertChannelType,
  parseAlertRuleKind,
  parseAlertSeverity,
} from "../../alert/repos/parsing";
import { RULE_REGISTRY } from "../../alert/rules/registry";
import { parseSelector, type AgentSelector } from "../../alert/selector";
import type { AppContext } from "../../app";
import type { DbClient } from "../../db/client";
import {
  agent,
  agentGroup,
  alertChannel,
  alertNotification,
  alertRule,
  alertRuleChannel,
  alertState,
} from "../../db/schema";
import { createLogger } from "../../logging/logger";
import {
  isRecord,
  MAX_NAME_LEN,
  parsePageQuery,
  parsePositiveIntQuery,
  parseStringArray,
  safeJsonParse,
  uniqueStrings,
} from "./parsing";

const alertLog = createLogger("alert");

async function validateSelectorIds(
  db: DbClient,
  selector: AgentSelector,
): Promise<{ code: string; missing: string[] } | null> {
  if (selector.type === "groups") {
    const existing = await db
      .select({ id: agentGroup.id })
      .from(agentGroup)
      .where(inArray(agentGroup.id, selector.groupIds));
    const set = new Set(existing.map((r) => r.id));
    const missing = selector.groupIds.filter((id) => !set.has(id));
    if (missing.length > 0) return { code: "invalid_group_ids", missing };
  }

  if (selector.type === "agents") {
    const existing = await db
      .select({ id: agent.id })
      .from(agent)
      .where(inArray(agent.id, selector.agentIds));
    const set = new Set(existing.map((r) => r.id));
    const missing = selector.agentIds.filter((id) => !set.has(id));
    if (missing.length > 0) return { code: "invalid_agent_ids", missing };
  }

  return null;
}

export function registerAdminAlertRoutes(router: Hono<AppContext>) {
  router.get("/alert-channels", async (c) => {
    const db = c.get("db");
    const { limit, offset } = parsePageQuery({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });

    // count + page in one read transaction → consistent total/rows snapshot.
    const { total, rows } = await db.transaction(async (tx) => {
      const totalRows = await tx.select({ n: sql<number>`count(*)` }).from(alertChannel);
      const total = Number(totalRows[0]?.n ?? 0);
      const rows = await tx
        .select({
          id: alertChannel.id,
          name: alertChannel.name,
          type: alertChannel.type,
          enabled: alertChannel.enabled,
          configJson: alertChannel.configJson,
          createdAtMs: alertChannel.createdAtMs,
          updatedAtMs: alertChannel.updatedAtMs,
        })
        .from(alertChannel)
        .orderBy(asc(alertChannel.name), asc(alertChannel.id))
        .limit(limit)
        .offset(offset);
      return { total, rows };
    });

    return c.json({
      total,
      limit,
      offset,
      channels: rows.map((r) => {
        const type = parseAlertChannelType(r.type) ?? "webhook";
        const notifier = resolveNotifier(type);
        const decoded = safeJsonParse(r.configJson) ?? {};
        const configResult = notifier?.parseConfig(decoded);
        const redacted = configResult?.ok
          ? notifier!.redactConfig(configResult.value)
          : { config: {}, meta: {} };
        return {
          id: r.id,
          name: r.name,
          type,
          enabled: r.enabled,
          config: redacted.config,
          meta: redacted.meta,
          createdAtMs: r.createdAtMs,
          updatedAtMs: r.updatedAtMs,
        };
      }),
    });
  });

  router.get("/alert-channels/options", async (c) => {
    const db = c.get("db");
    const rows = await db
      .select({
        id: alertChannel.id,
        name: alertChannel.name,
        type: alertChannel.type,
        enabled: alertChannel.enabled,
      })
      .from(alertChannel)
      .orderBy(asc(alertChannel.name), asc(alertChannel.id));
    // Coerce stale stored types into the known set, mirroring the main list endpoint.
    const channels = rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: parseAlertChannelType(r.type) ?? "webhook",
      enabled: r.enabled,
    }));
    return c.json({ channels });
  });

  router.post("/alert-channels", async (c) => {
    const db = c.get("db");

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

    const type = parseAlertChannelType(body["type"]);
    if (!type) return c.json({ code: "invalid_type" }, 400);

    const notifier = resolveNotifier(type);
    if (!notifier) return c.json({ code: "invalid_type" }, 400);

    const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : true;

    const configResult = notifier.parseConfig(body["config"]);
    if (!configResult.ok) {
      alertLog.warn(
        `invalid channel config: type=${type} errors=${JSON.stringify(configResult.error)}`,
      );
      return c.json({ code: "invalid_config", errors: configResult.error }, 400);
    }

    const nowMs = Date.now();
    const id = crypto.randomUUID();
    await db.insert(alertChannel).values({
      id,
      name,
      type,
      enabled,
      configJson: JSON.stringify(configResult.value),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    return c.json({ ok: true, id });
  });

  router.patch("/alert-channels/:channelId", async (c) => {
    const db = c.get("db");
    const channelId = c.req.param("channelId");

    const existing = await db
      .select({ id: alertChannel.id, type: alertChannel.type, configJson: alertChannel.configJson })
      .from(alertChannel)
      .where(eq(alertChannel.id, channelId))
      .limit(1);
    if (existing.length === 0) return c.json({ code: "not_found" }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const type = parseAlertChannelType(existing[0]!.type);
    if (!type) return c.json({ code: "invalid_type" }, 400);

    if (body["type"] !== undefined && parseAlertChannelType(body["type"]) !== type) {
      return c.json({ code: "type_change_not_allowed" }, 400);
    }

    const notifier = resolveNotifier(type);
    if (!notifier) return c.json({ code: "invalid_type" }, 400);

    const patch: Record<string, unknown> = {};

    if (body["name"] !== undefined) {
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (!name) return c.json({ code: "missing_name" }, 400);
      if (name.length > MAX_NAME_LEN) return c.json({ code: "name_too_long" }, 400);
      patch["name"] = name;
    }

    if (body["enabled"] !== undefined) {
      if (typeof body["enabled"] !== "boolean") return c.json({ code: "invalid_enabled" }, 400);
      patch["enabled"] = body["enabled"];
    }

    if (body["config"] !== undefined) {
      const existingDecoded = safeJsonParse(existing[0]!.configJson) ?? {};
      const prevResult = notifier.parseConfig(existingDecoded);
      const prev = prevResult.ok ? prevResult.value : undefined;
      const configResult = notifier.parseConfig(body["config"], prev);
      if (!configResult.ok) {
        alertLog.warn(`invalid channel config on update: id=${channelId} type=${type}`);
        return c.json({ code: "invalid_config", errors: configResult.error }, 400);
      }
      patch["configJson"] = JSON.stringify(configResult.value);
    }

    if (Object.keys(patch).length === 0) return c.json({ ok: true });
    patch["updatedAtMs"] = Date.now();

    await db.update(alertChannel).set(patch).where(eq(alertChannel.id, channelId));
    return c.json({ ok: true });
  });

  router.delete("/alert-channels/:channelId", async (c) => {
    const db = c.get("db");
    const channelId = c.req.param("channelId");
    const deleted = await db
      .delete(alertChannel)
      .where(eq(alertChannel.id, channelId))
      .returning({ id: alertChannel.id });
    if (deleted.length === 0) return c.json({ code: "not_found" }, 404);
    return c.json({ ok: true });
  });

  router.post("/alert-channels/:channelId/test", async (c) => {
    const db = c.get("db");
    const channelId = c.req.param("channelId");

    const rows = await db
      .select({
        id: alertChannel.id,
        type: alertChannel.type,
        configJson: alertChannel.configJson,
        enabled: alertChannel.enabled,
      })
      .from(alertChannel)
      .where(eq(alertChannel.id, channelId))
      .limit(1);
    if (rows.length === 0) return c.json({ code: "not_found" }, 404);
    if (!rows[0]!.enabled) return c.json({ code: "channel_disabled" }, 400);

    const type = parseAlertChannelType(rows[0]!.type);
    if (!type) return c.json({ code: "invalid_type" }, 400);

    const notifier = resolveNotifier(type);
    if (!notifier) return c.json({ code: "invalid_type" }, 400);

    const configResult = notifier.parseConfig(safeJsonParse(rows[0]!.configJson) ?? {});
    if (!configResult.ok) {
      alertLog.error(`stored channel config invalid: id=${channelId} type=${type}`);
      return c.json({ code: "invalid_config" }, 400);
    }

    const message = buildSampleMessage();
    const store = c.get("siteConfig");
    const publicBaseUrl = store.getCurrent().publicBaseUrl || undefined;
    const result = await notifier.send(
      { message, publicBaseUrl, nowMs: Date.now() },
      configResult.value,
    );

    if (result.kind === "ok") return c.json({ ok: true });
    return c.json({ code: "send_failed", error: result.error }, 400);
  });

  router.get("/alert-rules", async (c) => {
    const db = c.get("db");
    const { limit, offset } = parsePageQuery({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });

    // count + page + channel links in one read transaction → consistent snapshot.
    const { total, rows, links } = await db.transaction(async (tx) => {
      const totalRows = await tx.select({ n: sql<number>`count(*)` }).from(alertRule);
      const total = Number(totalRows[0]?.n ?? 0);

      const rows = await tx
        .select({
          id: alertRule.id,
          name: alertRule.name,
          enabled: alertRule.enabled,
          severity: alertRule.severity,
          kind: alertRule.kind,
          selectorJson: alertRule.selectorJson,
          paramsJson: alertRule.paramsJson,
          forMs: alertRule.forMs,
          recoverMs: alertRule.recoverMs,
          notifyOnRecovery: alertRule.notifyOnRecovery,
          createdAtMs: alertRule.createdAtMs,
          updatedAtMs: alertRule.updatedAtMs,
        })
        .from(alertRule)
        .orderBy(asc(alertRule.name), asc(alertRule.id))
        .limit(limit)
        .offset(offset);

      const ruleIds = rows.map((r) => r.id);
      const links = ruleIds.length
        ? await tx
            .select({
              ruleId: alertRuleChannel.ruleId,
              channelId: alertChannel.id,
              channelName: alertChannel.name,
              channelType: alertChannel.type,
              channelEnabled: alertChannel.enabled,
            })
            .from(alertRuleChannel)
            .innerJoin(alertChannel, eq(alertRuleChannel.channelId, alertChannel.id))
            .where(inArray(alertRuleChannel.ruleId, ruleIds))
            .orderBy(asc(alertChannel.name))
        : [];

      return { total, rows, links };
    });

    const channelsByRuleId = new Map<
      string,
      { id: string; name: string; type: string; enabled: boolean }[]
    >();
    for (const l of links) {
      const list = channelsByRuleId.get(l.ruleId) ?? [];
      list.push({
        id: l.channelId,
        name: l.channelName,
        type: l.channelType,
        enabled: l.channelEnabled,
      });
      channelsByRuleId.set(l.ruleId, list);
    }

    return c.json({
      total,
      limit,
      offset,
      rules: rows.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        severity: r.severity,
        kind: r.kind,
        selector: safeJsonParse(r.selectorJson),
        params: safeJsonParse(r.paramsJson),
        forMs: r.forMs,
        recoverMs: r.recoverMs,
        notifyOnRecovery: r.notifyOnRecovery,
        channels: channelsByRuleId.get(r.id) ?? [],
        createdAtMs: r.createdAtMs,
        updatedAtMs: r.updatedAtMs,
      })),
    });
  });

  router.post("/alert-rules", async (c) => {
    const db = c.get("db");

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

    const severity = parseAlertSeverity(body["severity"]);
    if (!severity) return c.json({ code: "invalid_severity" }, 400);

    const kind = parseAlertRuleKind(body["kind"]);
    if (!kind) return c.json({ code: "invalid_kind" }, 400);

    const def = RULE_REGISTRY[kind];
    if (!def) return c.json({ code: "invalid_kind" }, 400);

    const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : true;
    const notifyOnRecovery =
      typeof body["notifyOnRecovery"] === "boolean" ? body["notifyOnRecovery"] : true;

    let forMs =
      typeof body["forMs"] === "number" &&
      Number.isFinite(body["forMs"]) &&
      Number.isInteger(body["forMs"])
        ? (body["forMs"] as number)
        : 0;
    let recoverMs =
      typeof body["recoverMs"] === "number" &&
      Number.isFinite(body["recoverMs"]) &&
      Number.isInteger(body["recoverMs"])
        ? (body["recoverMs"] as number)
        : 0;
    if (forMs < 0 || forMs > 24 * 60 * 60 * 1000) return c.json({ code: "invalid_for_ms" }, 400);
    if (recoverMs < 0 || recoverMs > 24 * 60 * 60 * 1000)
      return c.json({ code: "invalid_recover_ms" }, 400);

    // Parse selector
    const selectorResult = parseSelector(body["selector"]);
    if (!selectorResult.ok)
      return c.json({ code: "invalid_selector", errors: selectorResult.error }, 400);
    const selector = selectorResult.value;

    const selectorErr = await validateSelectorIds(db, selector);
    if (selectorErr) return c.json(selectorErr, 400);

    // Parse kind-specific params via the rule registry
    const paramsResult = def.parseParams(body["params"]);
    if (!paramsResult.ok)
      return c.json({ code: "invalid_params", errors: paramsResult.error }, 400);

    if (def.mode === "event") {
      forMs = 0;
      recoverMs = 0;
    }

    // Validate channel IDs
    const channelIds = uniqueStrings(parseStringArray(body["channelIds"]));
    if (channelIds.length > 0) {
      const existingChannels = await db
        .select({ id: alertChannel.id })
        .from(alertChannel)
        .where(inArray(alertChannel.id, channelIds));
      const existingSet = new Set(existingChannels.map((r) => r.id));
      for (const id of channelIds) {
        if (!existingSet.has(id)) return c.json({ code: "invalid_channel_ids" }, 400);
      }
    }

    const nowMs = Date.now();
    const id = crypto.randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(alertRule).values({
        id,
        name,
        enabled,
        severity,
        kind,
        selectorJson: JSON.stringify(selector),
        paramsJson: JSON.stringify(paramsResult.value),
        forMs,
        recoverMs,
        notifyOnRecovery,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });

      if (channelIds.length > 0) {
        await tx
          .insert(alertRuleChannel)
          .values(channelIds.map((channelId) => ({ ruleId: id, channelId, createdAtMs: nowMs })));
      }
    });

    return c.json({ ok: true, id });
  });

  router.patch("/alert-rules/:ruleId", async (c) => {
    const db = c.get("db");
    const ruleId = c.req.param("ruleId");

    const existing = await db
      .select({
        id: alertRule.id,
        kind: alertRule.kind,
        enabled: alertRule.enabled,
        selectorJson: alertRule.selectorJson,
        paramsJson: alertRule.paramsJson,
      })
      .from(alertRule)
      .where(eq(alertRule.id, ruleId))
      .limit(1);
    if (existing.length === 0) return c.json({ code: "not_found" }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const patch: Record<string, unknown> = {};
    let resetState = false;

    if (body["name"] !== undefined) {
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (!name) return c.json({ code: "missing_name" }, 400);
      if (name.length > MAX_NAME_LEN) return c.json({ code: "name_too_long" }, 400);
      patch["name"] = name;
    }

    if (body["enabled"] !== undefined) {
      if (typeof body["enabled"] !== "boolean") return c.json({ code: "invalid_enabled" }, 400);
      patch["enabled"] = body["enabled"];
      if (body["enabled"] !== existing[0]!.enabled) resetState = true;
    }

    if (body["severity"] !== undefined) {
      const severity = parseAlertSeverity(body["severity"]);
      if (!severity) return c.json({ code: "invalid_severity" }, 400);
      patch["severity"] = severity;
    }

    const nextKind =
      body["kind"] !== undefined
        ? parseAlertRuleKind(body["kind"])
        : (parseAlertRuleKind(existing[0]!.kind) ?? null);
    if (!nextKind) return c.json({ code: "invalid_kind" }, 400);
    if (body["kind"] !== undefined) patch["kind"] = nextKind;

    const nextDef = RULE_REGISTRY[nextKind];
    if (!nextDef) return c.json({ code: "invalid_kind" }, 400);

    if (body["notifyOnRecovery"] !== undefined) {
      if (typeof body["notifyOnRecovery"] !== "boolean")
        return c.json({ code: "invalid_notify_on_recovery" }, 400);
      patch["notifyOnRecovery"] = body["notifyOnRecovery"];
    }

    if (body["forMs"] !== undefined) {
      if (
        typeof body["forMs"] !== "number" ||
        !Number.isFinite(body["forMs"]) ||
        !Number.isInteger(body["forMs"])
      )
        return c.json({ code: "invalid_for_ms" }, 400);
      const forMs = body["forMs"] as number;
      if (forMs < 0 || forMs > 24 * 60 * 60 * 1000) return c.json({ code: "invalid_for_ms" }, 400);
      patch["forMs"] = forMs;
    }

    if (body["recoverMs"] !== undefined) {
      if (
        typeof body["recoverMs"] !== "number" ||
        !Number.isFinite(body["recoverMs"]) ||
        !Number.isInteger(body["recoverMs"])
      )
        return c.json({ code: "invalid_recover_ms" }, 400);
      const recoverMs = body["recoverMs"] as number;
      if (recoverMs < 0 || recoverMs > 24 * 60 * 60 * 1000)
        return c.json({ code: "invalid_recover_ms" }, 400);
      patch["recoverMs"] = recoverMs;
    }

    let nextSelector: AgentSelector | undefined;
    if (body["selector"] !== undefined) {
      const selectorResult = parseSelector(body["selector"]);
      if (!selectorResult.ok)
        return c.json({ code: "invalid_selector", errors: selectorResult.error }, 400);
      const selectorErr = await validateSelectorIds(db, selectorResult.value);
      if (selectorErr) return c.json(selectorErr, 400);
      patch["selectorJson"] = JSON.stringify(selectorResult.value);
      resetState = true;
      nextSelector = selectorResult.value;
    }

    if (body["params"] !== undefined || body["kind"] !== undefined) {
      const rawParams =
        body["params"] !== undefined
          ? body["params"]
          : (safeJsonParse(existing[0]!.paramsJson) ?? {});
      const paramsResult = nextDef.parseParams(rawParams);
      if (!paramsResult.ok)
        return c.json({ code: "invalid_params", errors: paramsResult.error }, 400);
      patch["paramsJson"] = JSON.stringify(paramsResult.value);
      resetState = true;
    }

    if (nextDef.mode === "event") {
      patch["forMs"] = 0;
      patch["recoverMs"] = 0;
    }

    const channelIds =
      body["channelIds"] !== undefined ? uniqueStrings(parseStringArray(body["channelIds"])) : null;
    if (channelIds && channelIds.length > 0) {
      const existingChannels = await db
        .select({ id: alertChannel.id })
        .from(alertChannel)
        .where(inArray(alertChannel.id, channelIds));
      const existingSet = new Set(existingChannels.map((r) => r.id));
      for (const id of channelIds) {
        if (!existingSet.has(id)) return c.json({ code: "invalid_channel_ids" }, 400);
      }
    }

    if (Object.keys(patch).length === 0 && channelIds === null) return c.json({ ok: true });
    patch["updatedAtMs"] = Date.now();

    await db.transaction(async (tx) => {
      if (Object.keys(patch).length > 0) {
        await tx.update(alertRule).set(patch).where(eq(alertRule.id, ruleId));
      }

      if (channelIds !== null) {
        await tx.delete(alertRuleChannel).where(eq(alertRuleChannel.ruleId, ruleId));
        if (channelIds.length > 0) {
          const nowMs = Date.now();
          await tx
            .insert(alertRuleChannel)
            .values(channelIds.map((channelId) => ({ ruleId, channelId, createdAtMs: nowMs })));
        }
      }

      if (resetState) {
        await tx.delete(alertState).where(eq(alertState.ruleId, ruleId));
      }

      if (nextSelector !== undefined) {
        const oldSelector = parseSelector(safeJsonParse(existing[0]!.selectorJson) ?? {});
        const oldGroupIds =
          oldSelector.ok && oldSelector.value.type === "groups" ? oldSelector.value.groupIds : [];
        const newGroupIds = nextSelector.type === "groups" ? nextSelector.groupIds : [];
        const kept = new Set(newGroupIds);
        const dropped = oldGroupIds.filter((id) => !kept.has(id));
        if (dropped.length > 0) await pruneUnusedAgentGroups(tx, dropped);
      }
    });

    return c.json({ ok: true });
  });

  router.delete("/alert-rules/:ruleId", async (c) => {
    const db = c.get("db");
    const ruleId = c.req.param("ruleId");
    const deleted = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(alertRule)
        .where(eq(alertRule.id, ruleId))
        .returning({ id: alertRule.id, selectorJson: alertRule.selectorJson });
      if (rows.length === 0) return rows;

      const oldSelector = parseSelector(safeJsonParse(rows[0]!.selectorJson) ?? {});
      if (oldSelector.ok && oldSelector.value.type === "groups") {
        await pruneUnusedAgentGroups(tx, oldSelector.value.groupIds);
      }
      return rows;
    });
    if (deleted.length === 0) return c.json({ code: "not_found" }, 404);
    return c.json({ ok: true });
  });

  router.get("/alerts/active", async (c) => {
    const db = c.get("db");
    const limit = Math.min(parsePositiveIntQuery(c.req.query("limit")) ?? 200, 500);

    const rows = await db
      .select({
        ruleId: alertState.ruleId,
        subjectKey: alertState.subjectKey,
        subjectJson: alertState.subjectJson,
        activeSinceMs: alertState.activeSinceMs,
        lastEvalAtMs: alertState.lastEvalAtMs,
        lastValueJson: alertState.lastValueJson,
        ruleName: alertRule.name,
        ruleSeverity: alertRule.severity,
        ruleKind: alertRule.kind,
      })
      .from(alertState)
      .innerJoin(alertRule, eq(alertState.ruleId, alertRule.id))
      .where(eq(alertState.active, true))
      .orderBy(desc(alertState.activeSinceMs), desc(alertState.lastEvalAtMs))
      .limit(limit);

    const agentIds = new Set<string>();
    for (const r of rows) {
      const subject = safeJsonParse(r.subjectJson);
      if (isRecord(subject) && typeof subject["agentId"] === "string") {
        agentIds.add(subject["agentId"] as string);
      }
    }
    const agentNameMap = new Map<string, string>();
    if (agentIds.size > 0) {
      const agentRows = await db
        .select({ id: agent.id, name: agent.name })
        .from(agent)
        .where(inArray(agent.id, [...agentIds]));
      for (const a of agentRows) agentNameMap.set(a.id, a.name);
    }

    return c.json({
      alerts: rows.map((r) => {
        const subject = safeJsonParse(r.subjectJson);
        const agentId =
          isRecord(subject) && typeof subject["agentId"] === "string"
            ? (subject["agentId"] as string)
            : null;
        const value = r.lastValueJson ? safeJsonParse(r.lastValueJson) : null;
        return {
          rule: { id: r.ruleId, name: r.ruleName, severity: r.ruleSeverity, kind: r.ruleKind },
          agentName: agentId ? (agentNameMap.get(agentId) ?? agentId) : null,
          activeSinceMs: r.activeSinceMs ?? null,
          lastEvalAtMs: r.lastEvalAtMs,
          valueSummary: value ? formatValueSummary(r.ruleKind, value) : null,
        };
      }),
    });
  });

  router.get("/alert-notifications", async (c) => {
    const db = c.get("db");
    const status = (c.req.query("status") ?? "").trim();
    const limit = Math.min(parsePositiveIntQuery(c.req.query("limit")) ?? 200, 500);
    const conditions = [];
    if (status) conditions.push(eq(alertNotification.status, status));

    const base = db
      .select({
        id: alertNotification.id,
        ruleId: alertNotification.ruleId,
        subjectKey: alertNotification.subjectKey,
        channelId: alertNotification.channelId,
        kind: alertNotification.kind,
        eventTsMs: alertNotification.eventTsMs,
        status: alertNotification.status,
        attempts: alertNotification.attempts,
        nextAttemptAtMs: alertNotification.nextAttemptAtMs,
        lastError: alertNotification.lastError,
        sentAtMs: alertNotification.sentAtMs,
        createdAtMs: alertNotification.createdAtMs,
        ruleName: alertRule.name,
        channelName: alertChannel.name,
        channelType: alertChannel.type,
      })
      .from(alertNotification)
      .leftJoin(alertRule, eq(alertNotification.ruleId, alertRule.id))
      .leftJoin(alertChannel, eq(alertNotification.channelId, alertChannel.id));

    const query = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const rows = await query.orderBy(desc(alertNotification.createdAtMs)).limit(limit);

    return c.json({
      notifications: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError ?? null,
        nextAttemptAtMs: r.nextAttemptAtMs,
        sentAtMs: r.sentAtMs ?? null,
        createdAtMs: r.createdAtMs,
        eventTsMs: r.eventTsMs,
        rule: { id: r.ruleId, name: r.ruleName ?? null },
        channel: { id: r.channelId, name: r.channelName ?? null, type: r.channelType ?? null },
        subjectKey: r.subjectKey,
      })),
    });
  });
}
