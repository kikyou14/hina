import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { alertNotification, alertRule, alertState } from "../../db/schema";
import type { SubjectState, Transition } from "../engine/subject-state";
import type { NotificationJob } from "./notifications-repo";

export type AlertStateRow = {
  ruleId: string;
  subjectKey: string;
  subjectJson: string;
  active: boolean;
  pendingSinceMs: number | null;
  recoverSinceMs: number | null;
  activeSinceMs: number | null;
  lastEvalAtMs: number;
  lastValueJson: string | null;
  lastFiredAtMs: number | null;
  lastRecoveredAtMs: number | null;
};

export async function loadStatesForRules(
  db: DbClient,
  ruleIds: string[],
): Promise<Map<string, AlertStateRow[]>> {
  const out = new Map<string, AlertStateRow[]>();
  for (const id of ruleIds) out.set(id, []);
  if (ruleIds.length === 0) return out;

  const rows = await db.select().from(alertState).where(inArray(alertState.ruleId, ruleIds));
  for (const row of rows) {
    out.get(row.ruleId)!.push(row);
  }
  return out;
}

function stateToColumns(s: SubjectState | null): {
  active: boolean;
  pendingSinceMs: number | null;
  recoverSinceMs: number | null;
  activeSinceMs: number | null;
} {
  if (s === null) {
    return { active: false, pendingSinceMs: null, recoverSinceMs: null, activeSinceMs: null };
  }
  if (s.active) {
    return {
      active: true,
      pendingSinceMs: null,
      recoverSinceMs: s.recoverSinceMs,
      activeSinceMs: s.activeSinceMs,
    };
  }
  return {
    active: false,
    pendingSinceMs: s.pendingSinceMs,
    recoverSinceMs: null,
    activeSinceMs: null,
  };
}

export type TransitionRow = {
  ruleId: string;
  ruleUpdatedAtMs: number;
  subjectKey: string;
  subjectJson: string;
  next: SubjectState | null;
  transition: Transition;
  valueJson: string | null;
  nowMs: number;
  prevLastFiredAtMs: number | null;
  prevLastRecoveredAtMs: number | null;
};

export type RuleEvaluationCommit = {
  ruleId: string;
  ruleUpdatedAtMs: number;
  transitions: TransitionRow[];
  notifications: NotificationJob[];
};

type UpsertRow = {
  ruleId: string;
  subjectKey: string;
  subjectJson: string;
  active: boolean;
  pendingSinceMs: number | null;
  recoverSinceMs: number | null;
  activeSinceMs: number | null;
  lastEvalAtMs: number;
  lastValueJson: string | null;
  lastFiredAtMs: number | null;
  lastRecoveredAtMs: number | null;
};

type PreparedCommit = {
  ruleId: string;
  ruleUpdatedAtMs: number;
  upserts: UpsertRow[];
  deleteKeys: string[];
  notifications: NotificationJob[];
};

function prepareCommit(commit: RuleEvaluationCommit): PreparedCommit {
  const upserts: UpsertRow[] = [];
  const deleteKeys: string[] = [];

  for (const r of commit.transitions) {
    if (r.next === null) {
      deleteKeys.push(r.subjectKey);
      continue;
    }

    const cols = stateToColumns(r.next);
    let lastFiredAtMs = r.prevLastFiredAtMs;
    let lastRecoveredAtMs = r.prevLastRecoveredAtMs;
    let lastValueJson = r.valueJson;

    if (r.transition !== null) {
      if (r.transition.kind === "fire") lastFiredAtMs = r.transition.firedAtMs;
      if (r.transition.kind === "recover") lastRecoveredAtMs = r.transition.recoveredAtMs;
      if (r.transition.kind === "reset") lastValueJson = null;
    }

    upserts.push({
      ruleId: r.ruleId,
      subjectKey: r.subjectKey,
      subjectJson: r.subjectJson,
      active: cols.active,
      pendingSinceMs: cols.pendingSinceMs,
      recoverSinceMs: cols.recoverSinceMs,
      activeSinceMs: cols.activeSinceMs,
      lastEvalAtMs: r.nowMs,
      lastValueJson,
      lastFiredAtMs,
      lastRecoveredAtMs,
    });
  }

  return {
    ruleId: commit.ruleId,
    ruleUpdatedAtMs: commit.ruleUpdatedAtMs,
    upserts,
    deleteKeys,
    notifications: commit.notifications,
  };
}

export async function commitRuleEvaluations(
  db: DbClient,
  commits: RuleEvaluationCommit[],
): Promise<void> {
  if (commits.length === 0) return;

  const prepared = commits.map(prepareCommit);

  await db.transaction(async (tx) => {
    for (const p of prepared) {
      const current = await tx
        .select({ updatedAtMs: alertRule.updatedAtMs })
        .from(alertRule)
        .where(eq(alertRule.id, p.ruleId))
        .limit(1);
      // OCC: skip both state writes and notifications when the rule has been
      // updated since this evaluation snapshot was taken.
      if (current.length === 0 || current[0]!.updatedAtMs !== p.ruleUpdatedAtMs) continue;

      if (p.upserts.length > 0) {
        await tx
          .insert(alertState)
          .values(p.upserts)
          .onConflictDoUpdate({
            target: [alertState.ruleId, alertState.subjectKey],
            set: {
              subjectJson: sql`excluded.subject_json`,
              active: sql`excluded.active`,
              pendingSinceMs: sql`excluded.pending_since_ms`,
              recoverSinceMs: sql`excluded.recover_since_ms`,
              activeSinceMs: sql`excluded.active_since_ms`,
              lastEvalAtMs: sql`excluded.last_eval_at_ms`,
              lastValueJson: sql`excluded.last_value_json`,
              lastFiredAtMs: sql`excluded.last_fired_at_ms`,
              lastRecoveredAtMs: sql`excluded.last_recovered_at_ms`,
            },
          });
      }

      if (p.deleteKeys.length > 0) {
        await tx
          .delete(alertState)
          .where(
            and(eq(alertState.ruleId, p.ruleId), inArray(alertState.subjectKey, p.deleteKeys)),
          );
      }

      if (p.notifications.length > 0) {
        await tx.insert(alertNotification).values(p.notifications).onConflictDoNothing();
      }
    }
  });
}
