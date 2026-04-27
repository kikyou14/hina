import * as React from "react";
import { useTranslation } from "react-i18next";

import type {
  AdminAlertChannelOption,
  AdminAlertRule,
  AlertRuleKind,
  AlertSeverity,
} from "@/api/adminAlerts";
import { ScopeSelector } from "@/components/ScopeSelector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { getUserErrorMessage } from "@/lib/userErrors";
import {
  CHANNEL_TYPE_BADGE,
  KIND_KEYS,
  MAX_DELAY_SEC,
  METRIC_OPTIONS,
  type MissingMode,
  OP_KEYS,
  type RuleFormPayload,
  type ThresholdOp,
  buildRulePayload,
  canSubmitRule,
  initRuleFormState,
  mergeRuleFormState,
} from "../lib/ruleFormHelpers";
import { SectionLabel } from "./SectionLabel";

export function AlertRuleForm(props: {
  mode: "create" | "edit";
  rule?: AdminAlertRule;
  agents: Array<{ id: string; name: string; group: string | null }>;
  groups: Array<{ id: string; name: string }>;
  probeTasks: Array<{ id: string; name: string; kind: string }>;
  channels: AdminAlertChannelOption[];
  pending: boolean;
  onSubmit: (v: RuleFormPayload) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [state, set] = React.useReducer(mergeRuleFormState, props.rule ?? null, initRuleFormState);
  const uid = React.useId();
  const fid = (suffix: string) => `${uid}-${suffix}`;

  const valid = canSubmitRule(state);
  const metricLabel = METRIC_OPTIONS.find((m) => m.key === state.metric)?.label ?? state.metric;

  return (
    <form
      className="grid gap-5"
      onSubmit={async (e) => {
        e.preventDefault();
        set({ error: null });
        try {
          const payload = buildRulePayload(state);
          await props.onSubmit(payload);
        } catch (err) {
          set({
            error: getUserErrorMessage(err, t, {
              action: props.mode === "edit" ? "update" : "create",
              fallback: t("settings.ruleForm.requestFailed"),
            }),
          });
        }
      }}
    >
      <div className="grid gap-1.5">
        <SectionLabel htmlFor={fid("name")}>{t("settings.ruleForm.ruleName")}</SectionLabel>
        <Input
          id={fid("name")}
          value={state.name}
          onChange={(e) => set({ name: e.target.value })}
          disabled={props.pending}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="grid min-w-0 gap-1.5">
          <SectionLabel htmlFor={fid("severity")}>{t("settings.ruleForm.severity")}</SectionLabel>
          <Select
            value={state.severity}
            onValueChange={(v) => set({ severity: v as AlertSeverity })}
          >
            <SelectTrigger id={fid("severity")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="info">{t("settings.ruleForm.severityOptions.info")}</SelectItem>
              <SelectItem value="warning">
                {t("settings.ruleForm.severityOptions.warning")}
              </SelectItem>
              <SelectItem value="critical">
                {t("settings.ruleForm.severityOptions.critical")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <SectionLabel htmlFor={fid("kind")}>{t("settings.ruleForm.kind")}</SectionLabel>
          <Select value={state.kind} onValueChange={(v) => set({ kind: v as AlertRuleKind })}>
            <SelectTrigger id={fid("kind")} className="w-full truncate">
              <SelectValue>{t(`settings.ruleForm.kindOptions.${state.kind}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {KIND_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`settings.ruleForm.kindOptions.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {state.kind !== "agent_expiring" && state.kind !== "route_change" ? (
          <>
            <div className="grid min-w-0 gap-1.5">
              <SectionLabel htmlFor={fid("forSec")}>
                {t("settings.ruleForm.triggerDelay")}
              </SectionLabel>
              <Input
                id={fid("forSec")}
                type="number"
                min={0}
                max={MAX_DELAY_SEC}
                value={state.forSec}
                onChange={(e) => set({ forSec: e.target.value })}
                disabled={props.pending}
              />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <SectionLabel htmlFor={fid("recoverSec")}>
                {t("settings.ruleForm.recoverDelay")}
              </SectionLabel>
              <Input
                id={fid("recoverSec")}
                type="number"
                min={0}
                max={MAX_DELAY_SEC}
                value={state.recoverSec}
                onChange={(e) => set({ recoverSec: e.target.value })}
                disabled={props.pending}
              />
            </div>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={state.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
            disabled={props.pending}
          />
          {t("common.enable")}
        </label>
        {state.kind !== "route_change" ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch
              checked={state.notifyOnRecovery}
              onCheckedChange={(v) => set({ notifyOnRecovery: v })}
              disabled={props.pending}
            />
            {t("settings.ruleForm.notifyOnRecovery")}
          </label>
        ) : null}
      </div>

      <hr />

      <div className="grid gap-4">
        <ScopeSelector
          agents={props.agents}
          groups={props.groups}
          scope={state.scope}
          onScopeChange={(scope) => set({ scope })}
          disabled={props.pending}
        />

        <div className="grid gap-1.5">
          <SectionLabel>{t("settings.ruleForm.channels.title")}</SectionLabel>
          {props.channels.length === 0 ? (
            <div className="text-muted-foreground text-xs">
              {t("settings.ruleForm.channels.noChannels")}
            </div>
          ) : null}
          <div className="space-y-1.5">
            {props.channels.map((c) => {
              const checked = state.channelIds.includes(c.id);
              const badge = CHANNEL_TYPE_BADGE[c.type];
              return (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-md border p-2.5 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        set({
                          channelIds: v
                            ? [...state.channelIds, c.id]
                            : state.channelIds.filter((x) => x !== c.id),
                        })
                      }
                    />
                    <span>{c.name}</span>
                  </div>
                  {badge ? (
                    <Badge className={badge.className}>{badge.label}</Badge>
                  ) : (
                    <Badge variant="outline">{c.type}</Badge>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {state.kind === "metric_threshold" ? (
        <>
          <hr />
          <div className="grid gap-3">
            <div>
              <div className="text-sm font-semibold">
                {t("settings.ruleForm.metricThreshold.title")}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="grid gap-1.5">
                <SectionLabel htmlFor={fid("metric")}>
                  {t("settings.ruleForm.metricThreshold.metric")}
                </SectionLabel>
                <Select value={state.metric} onValueChange={(v) => set({ metric: v })}>
                  <SelectTrigger id={fid("metric")} className="w-full">
                    <SelectValue>{metricLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_OPTIONS.map((m) => (
                      <SelectItem key={m.key} value={m.key}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <SectionLabel htmlFor={fid("metric-op")}>
                  {t("settings.ruleForm.metricThreshold.op")}
                </SectionLabel>
                <Select value={state.op} onValueChange={(v) => set({ op: v as ThresholdOp })}>
                  <SelectTrigger id={fid("metric-op")} className="w-full">
                    <SelectValue>{t(`settings.ruleForm.opOptions.${state.op}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {OP_KEYS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(`settings.ruleForm.opOptions.${k}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <SectionLabel htmlFor={fid("metric-threshold")}>
                  {t("settings.ruleForm.metricThreshold.value")}
                </SectionLabel>
                <Input
                  id={fid("metric-threshold")}
                  type="number"
                  value={state.threshold}
                  onChange={(e) => set({ threshold: e.target.value })}
                  disabled={props.pending}
                />
              </div>
              <div className="grid gap-1.5">
                <SectionLabel htmlFor={fid("missing")}>
                  {t("settings.ruleForm.metricThreshold.missing")}
                </SectionLabel>
                <Select
                  value={state.missing}
                  onValueChange={(v) => set({ missing: v as MissingMode })}
                >
                  <SelectTrigger id={fid("missing")} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ignore">
                      {t("settings.ruleForm.missingOptions.ignore")}
                    </SelectItem>
                    <SelectItem value="alert">
                      {t("settings.ruleForm.missingOptions.alert")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="text-muted-foreground bg-muted/50 rounded-md px-3 py-2 text-xs">
              {t("settings.ruleForm.metricThreshold.preview")}: {metricLabel} {state.op}{" "}
              {state.threshold}
            </div>
          </div>
        </>
      ) : null}

      {state.kind === "route_change" ? (
        <>
          <hr />
          <div className="grid gap-3">
            <div>
              <div className="text-sm font-semibold">{t("settings.ruleForm.probeTasks.title")}</div>
            </div>
            <div className="max-h-36 space-y-1.5 overflow-auto rounded-md border p-2">
              {props.probeTasks.filter((tk) => tk.kind === "traceroute").length === 0 ? (
                <div className="text-muted-foreground text-xs">
                  {t("settings.ruleForm.probeTasks.noProbeTasks")}
                </div>
              ) : null}
              {props.probeTasks
                .filter((tk) => tk.kind === "traceroute")
                .map((tk) => {
                  const checked = state.taskIds.includes(tk.id);
                  return (
                    <label
                      key={tk.id}
                      className="flex cursor-pointer items-center justify-between gap-2 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) =>
                            set({
                              taskIds: v
                                ? [...state.taskIds, tk.id]
                                : state.taskIds.filter((x) => x !== tk.id),
                            })
                          }
                        />
                        <span>{tk.name}</span>
                      </div>
                      <Badge variant="outline">{tk.kind}</Badge>
                    </label>
                  );
                })}
            </div>
          </div>
        </>
      ) : null}

      {state.kind === "probe_failed" || state.kind === "probe_latency" ? (
        <>
          <hr />
          <div className="grid gap-3">
            <div>
              <div className="text-sm font-semibold">{t("settings.ruleForm.probeTasks.title")}</div>
            </div>
            <div className="max-h-36 space-y-1.5 overflow-auto rounded-md border p-2">
              {props.probeTasks.length === 0 ? (
                <div className="text-muted-foreground text-xs">
                  {t("settings.ruleForm.probeTasks.noProbeTasks")}
                </div>
              ) : null}
              {props.probeTasks.map((tk) => {
                const checked = state.taskIds.includes(tk.id);
                return (
                  <label
                    key={tk.id}
                    className="flex cursor-pointer items-center justify-between gap-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          set({
                            taskIds: v
                              ? [...state.taskIds, tk.id]
                              : state.taskIds.filter((x) => x !== tk.id),
                          })
                        }
                      />
                      <span>{tk.name}</span>
                    </div>
                    <Badge variant="outline">{tk.kind}</Badge>
                  </label>
                );
              })}
            </div>
            {state.kind === "probe_latency" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <SectionLabel htmlFor={fid("probe-op")}>
                    {t("settings.ruleForm.metricThreshold.op")}
                  </SectionLabel>
                  <Select value={state.op} onValueChange={(v) => set({ op: v as ThresholdOp })}>
                    <SelectTrigger id={fid("probe-op")} className="w-full">
                      <SelectValue>{t(`settings.ruleForm.opOptions.${state.op}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {OP_KEYS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {t(`settings.ruleForm.opOptions.${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <SectionLabel htmlFor={fid("probe-threshold")}>
                    {t("settings.ruleForm.probeTasks.latencyThreshold")}
                  </SectionLabel>
                  <Input
                    id={fid("probe-threshold")}
                    type="number"
                    min={0}
                    value={state.threshold}
                    onChange={(e) => set({ threshold: e.target.value })}
                    disabled={props.pending}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {state.kind === "quota_exceeded" ? (
        <>
          <hr />
          <div className="grid gap-3">
            <div>
              <div className="text-sm font-semibold">
                {t("settings.ruleForm.quotaExceeded.title")}
              </div>
              <div className="text-muted-foreground text-xs">
                {t("settings.ruleForm.quotaExceeded.description")}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <SectionLabel htmlFor={fid("quota")}>
                  {t("settings.ruleForm.quotaExceeded.percentage")}
                </SectionLabel>
                <Input
                  id={fid("quota")}
                  type="number"
                  min={0}
                  max={100}
                  value={state.quotaPercentage}
                  onChange={(e) => set({ quotaPercentage: e.target.value })}
                  disabled={props.pending}
                  placeholder="80"
                />
              </div>
            </div>
          </div>
        </>
      ) : null}

      {state.kind === "agent_expiring" ? (
        <>
          <hr />
          <div className="grid gap-3">
            <div>
              <div className="text-sm font-semibold">
                {t("settings.ruleForm.agentExpiring.title")}
              </div>
              <div className="text-muted-foreground text-xs">
                {t("settings.ruleForm.agentExpiring.description")}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <SectionLabel htmlFor={fid("daysBeforeExpiry")}>
                  {t("settings.ruleForm.agentExpiring.daysBeforeExpiry")}
                </SectionLabel>
                <Input
                  id={fid("daysBeforeExpiry")}
                  type="number"
                  min={1}
                  max={365}
                  value={state.daysBeforeExpiry}
                  onChange={(e) => set({ daysBeforeExpiry: e.target.value })}
                  disabled={props.pending}
                  placeholder="7"
                />
              </div>
            </div>
          </div>
        </>
      ) : null}

      {state.error ? (
        <div className="text-destructive text-sm" role="alert">
          {state.error}
        </div>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={props.pending || !valid}>
          {props.pending
            ? t("common.saving")
            : props.mode === "edit"
              ? t("common.save")
              : t("common.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
