import { sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appKv = sqliteTable("app_kv", {
  key: text("k").primaryKey(),
  value: text("v").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    lastLoginAtMs: integer("last_login_at_ms"),
  },
  () => [],
);

export const userSession = sqliteTable(
  "user_session",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAtMs: integer("created_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    lastSeenAtMs: integer("last_seen_at_ms").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("idx_user_session_user_id").on(t.userId),
    index("idx_user_session_expires").on(t.expiresAtMs),
  ],
);

export const loginAttempt = sqliteTable(
  "login_attempt",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tsMs: integer("ts_ms").notNull(),
    success: integer("success", { mode: "boolean" }).notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    usernameAttempted: text("username_attempted"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    reason: text("reason").notNull(),
  },
  (t) => [
    index("idx_login_attempt_ts").on(t.tsMs),
    index("idx_login_attempt_ip_ts").on(t.ip, t.tsMs),
  ],
);

export const agentGroup = sqliteTable(
  "agent_group",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  () => [],
);

export const agent = sqliteTable(
  "agent",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    name: text("name").notNull(),
    groupId: text("group_id").references(() => agentGroup.id, { onDelete: "set null" }),
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
    tagsJson: text("tags_json").notNull().default("[]"),
    note: text("note"),
    geoCountryCode: text("geo_country_code"),
    geoCountry: text("geo_country"),
    geoSource: text("geo_source"),
    displayOrder: integer("display_order").notNull().default(0),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_agent_group_id").on(t.groupId)],
);

export const agentStatus = sqliteTable("agent_status", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agent.id, { onDelete: "cascade" }),
  online: integer("online", { mode: "boolean" }).notNull().default(false),
  lastSeenAtMs: integer("last_seen_at_ms"),
  lastIpV4: text("last_ip_v4"),
  lastIpV6: text("last_ip_v6"),
  lastHost: text("last_host"),
  lastOs: text("last_os"),
  lastArch: text("last_arch"),
  lastAgentVersion: text("last_agent_version"),
  lastCapabilitiesJson: text("last_capabilities_json"),
  lastHelloAtMs: integer("last_hello_at_ms"),
  lastSeq: integer("last_seq"),
  lastMetricsPack: blob("last_metrics_pack", { mode: "buffer" }),
  lastInventoryPack: blob("last_inventory_pack", { mode: "buffer" }),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const metricRollup = sqliteTable(
  "metric_rollup",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    intervalSec: integer("interval_sec").notNull(),
    bucketStartMs: integer("bucket_start_ms").notNull(),
    samples: integer("samples").notNull(),
    cpuPct: real("cpu_pct"),
    cpuSamples: integer("cpu_samples").notNull().default(0),
    memUsedPct: real("mem_used_pct"),
    memUsedSamples: integer("mem_used_samples").notNull().default(0),
    diskUsedPct: real("disk_used_pct"),
    diskUsedSamples: integer("disk_used_samples").notNull().default(0),
    procCount: real("proc_count"),
    procCountSamples: integer("proc_count_samples").notNull().default(0),
    connTcp: real("conn_tcp"),
    connTcpSamples: integer("conn_tcp_samples").notNull().default(0),
    connUdp: real("conn_udp"),
    connUdpSamples: integer("conn_udp_samples").notNull().default(0),
    // Accumulated network bytes within the bucket. Charts derive
    // rate as bytes / intervalSec at query time.
    rxBytesSum: integer("rx_bytes_sum").notNull(),
    txBytesSum: integer("tx_bytes_sum").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.intervalSec, t.bucketStartMs] }),
    index("idx_metric_rollup_interval_bucket").on(t.intervalSec, t.bucketStartMs),
  ],
);

export const trafficDay = sqliteTable(
  "traffic_day",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    dayYyyyMmDd: integer("day_yyyymmdd").notNull(),
    rxBytes: integer("rx_bytes").notNull(),
    txBytes: integer("tx_bytes").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.dayYyyyMmDd] }),
    index("idx_traffic_day_day").on(t.dayYyyyMmDd),
  ],
);

export const trafficCounter = sqliteTable("traffic_counter", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agent.id, { onDelete: "cascade" }),
  lastTsMs: integer("last_ts_ms").notNull(),
  lastRxBytesTotal: integer("last_rx_bytes_total").notNull(),
  lastTxBytesTotal: integer("last_tx_bytes_total").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentBilling = sqliteTable("agent_billing", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agent.id, { onDelete: "cascade" }),
  quotaBytes: integer("quota_bytes").notNull().default(0),
  mode: text("mode").notNull(),
  resetDay: integer("reset_day").notNull().default(1),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentPricing = sqliteTable(
  "agent_pricing",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agent.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    cycle: text("cycle").notNull(),
    amountUnit: integer("amount_unit").notNull(),
    expiresAtMs: integer("expires_at_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_agent_pricing_expires").on(t.expiresAtMs)],
);

export const probeTask = sqliteTable(
  "probe_task",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    targetJson: text("target_json").notNull(),
    intervalSec: integer("interval_sec").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    allAgents: integer("all_agents", { mode: "boolean" }).notNull().default(false),
    traceRevealHopDetails: integer("trace_reveal_hop_details", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    displayOrder: integer("display_order").notNull().default(0),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_probe_task_kind").on(t.kind), index("idx_probe_task_enabled").on(t.enabled)],
);

export const probeTaskGroup = sqliteTable(
  "probe_task_group",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => probeTask.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => agentGroup.id, { onDelete: "cascade" }),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.groupId] }),
    index("idx_probe_task_group_group_id").on(t.groupId),
  ],
);

export const probeTaskAgent = sqliteTable(
  "probe_task_agent",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => probeTask.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.agentId] }),
    index("idx_probe_task_agent_agent_id").on(t.agentId),
  ],
);

export const probeResult = sqliteTable(
  "probe_result",
  {
    id: integer("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => probeTask.id, { onDelete: "cascade" }),
    tsMs: integer("ts_ms").notNull(),
    recvTsMs: integer("recv_ts_ms").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    latMs: integer("lat_ms"),
    code: integer("code"),
    err: text("err"),
    extraJson: text("extra_json"),
    lossPct: real("loss_pct"),
    jitterMs: real("jitter_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("idx_probe_result_agent_task_ts").on(t.agentId, t.taskId, t.tsMs),
    index("idx_probe_result_task_ts").on(t.taskId, t.tsMs),
    index("idx_probe_result_recv_ts").on(t.recvTsMs),
  ],
);

export const probeResultLatest = sqliteTable(
  "probe_result_latest",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => probeTask.id, { onDelete: "cascade" }),
    tsMs: integer("ts_ms").notNull(),
    recvTsMs: integer("recv_ts_ms").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    latMs: integer("lat_ms"),
    code: integer("code"),
    err: text("err"),
    extraJson: text("extra_json"),
    lossPct: real("loss_pct"),
    jitterMs: real("jitter_ms"),
    routeObservationSignature: text("route_observation_signature"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.taskId] }),
    index("idx_probe_result_latest_task_id").on(t.taskId),
    index("idx_probe_result_latest_agent_id").on(t.agentId),
  ],
);

export const probeResultHourly = sqliteTable(
  "probe_result_hourly",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => probeTask.id, { onDelete: "cascade" }),
    bucketStartMs: integer("bucket_start_ms").notNull(),
    samples: integer("samples").notNull(),
    okSamples: integer("ok_samples").notNull(),
    latSamples: integer("lat_samples").notNull(),
    latSumMs: integer("lat_sum_ms").notNull(),
    latMinMs: integer("lat_min_ms"),
    latMaxMs: integer("lat_max_ms"),
    lossSamples: integer("loss_samples").notNull(),
    lossSumPct: real("loss_sum_pct").notNull(),
    lossMaxPct: real("loss_max_pct"),
    jitSamples: integer("jit_samples").notNull(),
    jitSumMs: real("jit_sum_ms").notNull(),
    jitMaxMs: real("jit_max_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.taskId, t.bucketStartMs] }),
    index("idx_probe_result_hourly_task_bucket").on(t.taskId, t.bucketStartMs),
    index("idx_probe_result_hourly_bucket").on(t.bucketStartMs),
  ],
);

export const probeResultDaily = sqliteTable(
  "probe_result_daily",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => probeTask.id, { onDelete: "cascade" }),
    bucketStartMs: integer("bucket_start_ms").notNull(),
    samples: integer("samples").notNull(),
    okSamples: integer("ok_samples").notNull(),
    latSamples: integer("lat_samples").notNull(),
    latSumMs: integer("lat_sum_ms").notNull(),
    latMinMs: integer("lat_min_ms"),
    latMaxMs: integer("lat_max_ms"),
    lossSamples: integer("loss_samples").notNull(),
    lossSumPct: real("loss_sum_pct").notNull(),
    lossMaxPct: real("loss_max_pct"),
    jitSamples: integer("jit_samples").notNull(),
    jitSumMs: real("jit_sum_ms").notNull(),
    jitMaxMs: real("jit_max_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.taskId, t.bucketStartMs] }),
    index("idx_probe_result_daily_task_bucket").on(t.taskId, t.bucketStartMs),
    index("idx_probe_result_daily_bucket").on(t.bucketStartMs),
  ],
);

export const alertRule = sqliteTable(
  "alert_rule",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    severity: text("severity").notNull(),
    kind: text("kind").notNull(),
    selectorJson: text("selector_json").notNull(),
    paramsJson: text("params_json").notNull(),
    forMs: integer("for_ms").notNull(),
    recoverMs: integer("recover_ms").notNull(),
    notifyOnRecovery: integer("notify_on_recovery", {
      mode: "boolean",
    }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_alert_rule_enabled").on(t.enabled)],
);

export const alertChannel = sqliteTable(
  "alert_channel",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    configJson: text("config_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_alert_channel_enabled").on(t.enabled)],
);

export const alertRuleChannel = sqliteTable(
  "alert_rule_channel",
  {
    ruleId: text("rule_id")
      .notNull()
      .references(() => alertRule.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => alertChannel.id, { onDelete: "cascade" }),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ruleId, t.channelId] }),
    index("idx_alert_rule_channel_channel_id").on(t.channelId),
  ],
);

export const alertState = sqliteTable(
  "alert_state",
  {
    ruleId: text("rule_id")
      .notNull()
      .references(() => alertRule.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    subjectJson: text("subject_json").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    pendingSinceMs: integer("pending_since_ms"),
    recoverSinceMs: integer("recover_since_ms"),
    activeSinceMs: integer("active_since_ms"),
    lastEvalAtMs: integer("last_eval_at_ms").notNull(),
    lastValueJson: text("last_value_json"),
    lastFiredAtMs: integer("last_fired_at_ms"),
    lastRecoveredAtMs: integer("last_recovered_at_ms"),
  },
  (t) => [
    primaryKey({ columns: [t.ruleId, t.subjectKey] }),
    index("idx_alert_state_active").on(t.active),
    index("idx_alert_state_last_eval").on(t.lastEvalAtMs),
  ],
);

export const alertNotification = sqliteTable(
  "alert_notification",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => alertRule.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => alertChannel.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    eventTsMs: integer("event_ts_ms").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAtMs: integer("next_attempt_at_ms").notNull(),
    lastError: text("last_error"),
    sentAtMs: integer("sent_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("idx_alert_notification_pending").on(t.status, t.nextAttemptAtMs),
    index("idx_alert_notification_created").on(t.createdAtMs),
    index("idx_alert_notification_cooldown").on(t.ruleId, t.subjectKey, t.createdAtMs),
  ],
);

export const routeChangeState = sqliteTable(
  "route_change_state",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => probeTask.id, { onDelete: "cascade" }),
    stableSignature: text("stable_signature"),
    stableObservedAtMs: integer("stable_observed_at_ms"),
    candidateSignature: text("candidate_signature"),
    candidateFirstSeenAtMs: integer("candidate_first_seen_at_ms"),
    candidateLastSeenAtMs: integer("candidate_last_seen_at_ms"),
    candidateSeenCount: integer("candidate_seen_count").notNull().default(0),
    candidateStrongSeenCount: integer("candidate_strong_seen_count").notNull().default(0),
    lastObservationTsMs: integer("last_observation_ts_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.taskId] }),
    index("idx_route_change_state_task_id").on(t.taskId),
  ],
);

export const schemaVersion = sql`1`;
