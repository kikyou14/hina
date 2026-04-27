import * as React from "react";
import { useTranslation } from "react-i18next";

import type { AdminProbeTask, ProbeKind, ProbeTaskTarget } from "@/api/adminProbes";
import type { ScopeState } from "@/components/ScopeSelector";
import { ScopeSelector } from "@/components/ScopeSelector";
import { Button } from "@/components/ui/button";
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
  isIpv6Literal,
  isValidHost,
  isValidHttpUrl,
  type ProbeTaskFormValue,
} from "../lib/probeValidation";
import { SectionLabel } from "./SectionLabel";

type ProbeFormField = "intervalSec" | "timeoutMs" | "url" | "host" | "port";
type ProbeFormError = { text: string; field: ProbeFormField | null };

function initScopeFromTask(task: AdminProbeTask | null): ScopeState {
  if (!task) return { mode: "specific", groupIds: [], agentIds: [] };
  if (task.allAgents) return { mode: "all", groupIds: [], agentIds: [] };
  if (task.groups.length > 0) {
    return {
      mode: "groups",
      groupIds: task.groups.map((g) => g.id),
      agentIds: task.agents.map((a) => a.id),
    };
  }
  return { mode: "specific", groupIds: [], agentIds: task.agents.map((a) => a.id) };
}

export function ProbeTaskForm(props: {
  mode: "create" | "edit";
  task?: AdminProbeTask;
  agents: Array<{ id: string; name: string; group: string | null }>;
  groups: Array<{ id: string; name: string }>;
  pending: boolean;
  onSubmit: (v: ProbeTaskFormValue) => Promise<void>;
}) {
  const { t } = useTranslation();
  const tsk = props.task ?? null;

  const [name, setName] = React.useState(tsk?.name ?? "");
  const [kind, setKind] = React.useState<ProbeKind>((tsk?.kind as ProbeKind) ?? "icmp");
  const [enabled, setEnabled] = React.useState(tsk?.enabled ?? true);
  const [traceRevealHopDetails, setTraceRevealHopDetails] = React.useState(
    tsk?.traceRevealHopDetails ?? false,
  );
  const [intervalSec, setIntervalSec] = React.useState(String(tsk?.intervalSec ?? 60));
  const [timeoutMs, setTimeoutMs] = React.useState(String(tsk?.timeoutMs ?? 5000));

  const initialHost = tsk?.target && "host" in tsk.target ? String(tsk.target.host) : "";
  const initialPort = tsk?.target && "port" in tsk.target ? String(tsk.target.port) : "";
  const initialUrl = tsk?.target && "url" in tsk.target ? String(tsk.target.url) : "";

  const [host, setHost] = React.useState(initialHost);
  const [port, setPort] = React.useState(initialPort);
  const [url, setUrl] = React.useState(initialUrl);

  const [scope, setScope] = React.useState<ScopeState>(() => initScopeFromTask(tsk));

  const [error, setError] = React.useState<ProbeFormError | null>(null);

  const target: ProbeTaskTarget | null = React.useMemo(() => {
    if (kind === "http") {
      return url.trim() ? { url: url.trim() } : null;
    }
    if (kind === "tcp") {
      const p = Number.parseInt(port, 10);
      if (!host.trim() || !Number.isFinite(p)) return null;
      return { host: host.trim(), port: p };
    }
    return host.trim() ? { host: host.trim() } : null;
  }, [kind, host, port, url]);

  const scopeValid =
    scope.mode === "all" ||
    (scope.mode === "groups" && scope.groupIds.length > 0) ||
    (scope.mode === "specific" && scope.agentIds.length > 0);
  const canSubmit = name.trim() && target && scopeValid;

  return (
    <form
      className="grid gap-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const interval = Number.parseInt(intervalSec, 10);
          const timeout = Number.parseInt(timeoutMs, 10);
          if (!Number.isFinite(interval) || interval < 1 || interval > 86400) {
            setError({ text: t("probes.form.invalidInterval"), field: "intervalSec" });
            return;
          }
          if (!Number.isFinite(timeout) || timeout < 100 || timeout > 120_000) {
            setError({ text: t("probes.form.invalidTimeout"), field: "timeoutMs" });
            return;
          }
          // Target validation per-kind. Each branch also builds a well-typed
          // ProbeTaskTarget so the payload does not need the useMemo'd `target`.
          let validTarget: ProbeTaskTarget;
          if (kind === "http") {
            const trimmedUrl = url.trim();
            if (!trimmedUrl) {
              setError({ text: t("probes.form.missingTarget"), field: "url" });
              return;
            }
            if (!isValidHttpUrl(trimmedUrl)) {
              setError({ text: t("probes.form.invalidUrl"), field: "url" });
              return;
            }
            validTarget = { url: trimmedUrl };
          } else if (kind === "tcp") {
            const trimmedHost = host.trim();
            if (!trimmedHost) {
              setError({ text: t("probes.form.missingTarget"), field: "host" });
              return;
            }
            if (!isValidHost(trimmedHost)) {
              setError({ text: t("probes.form.invalidHost"), field: "host" });
              return;
            }
            const p = Number.parseInt(port, 10);
            if (!Number.isInteger(p) || p < 1 || p > 65535) {
              setError({ text: t("probes.form.invalidPort"), field: "port" });
              return;
            }
            validTarget = { host: trimmedHost, port: p };
          } else {
            // icmp / traceroute
            const trimmedHost = host.trim();
            if (!trimmedHost) {
              setError({ text: t("probes.form.missingTarget"), field: "host" });
              return;
            }
            if (!isValidHost(trimmedHost)) {
              setError({ text: t("probes.form.invalidHost"), field: "host" });
              return;
            }
            if (kind === "traceroute" && isIpv6Literal(trimmedHost)) {
              setError({
                text: t("probes.form.tracerouteIpv6NotSupported"),
                field: "host",
              });
              return;
            }
            validTarget = { host: trimmedHost };
          }

          const payload: ProbeTaskFormValue = {
            name: name.trim(),
            kind,
            target: validTarget,
            intervalSec: interval,
            timeoutMs: timeout,
            enabled,
            allAgents: scope.mode === "all",
            traceRevealHopDetails,
            groupIds: scope.mode === "groups" ? scope.groupIds : [],
            agentIds: scope.mode === "specific" ? scope.agentIds : [],
          };

          await props.onSubmit(payload);
        } catch (err) {
          setError({
            text: getUserErrorMessage(err, t, {
              action: props.mode === "edit" ? "update" : "create",
              fallback: t("probes.form.requestFailed"),
            }),
            field: null,
          });
        }
      }}
    >
      <div className="grid gap-1.5">
        <SectionLabel>{t("common.name")}</SectionLabel>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={props.pending}
          maxLength={50}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <div className="grid min-w-0 gap-1.5">
          <SectionLabel>{t("probes.filters.kind")}</SectionLabel>
          <Select
            value={kind}
            onValueChange={(v) => {
              const nextKind = v as ProbeKind;
              setKind(nextKind);
              // Target input set changes with kind; clear only target-related errors.
              // interval/timeout errors are kind-independent and must be preserved.
              if (error?.field === "url" || error?.field === "host" || error?.field === "port") {
                setError(null);
              }
              if (nextKind !== "traceroute") setTraceRevealHopDetails(false);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="icmp">icmp</SelectItem>
              <SelectItem value="tcp">tcp</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="traceroute">traceroute</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <SectionLabel>{t("probes.form.intervalSec")}</SectionLabel>
          <Input
            type="number"
            min={1}
            max={86400}
            value={intervalSec}
            onChange={(e) => {
              setIntervalSec(e.target.value);
              if (error?.field === "intervalSec") setError(null);
            }}
            disabled={props.pending}
            aria-invalid={error?.field === "intervalSec"}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <SectionLabel>{t("probes.form.timeoutMs")}</SectionLabel>
          <Input
            type="number"
            min={100}
            max={120000}
            value={timeoutMs}
            onChange={(e) => {
              setTimeoutMs(e.target.value);
              if (error?.field === "timeoutMs") setError(null);
            }}
            disabled={props.pending}
            aria-invalid={error?.field === "timeoutMs"}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={props.pending} />
          {t("common.enable")}
        </label>
        {kind === "traceroute" ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch
              checked={traceRevealHopDetails}
              onCheckedChange={setTraceRevealHopDetails}
              disabled={props.pending}
            />
            {t("probes.form.traceRevealHopDetails")}
          </label>
        ) : null}
      </div>

      <hr />

      <ScopeSelector
        agents={props.agents}
        groups={props.groups}
        scope={scope}
        onScopeChange={setScope}
        disabled={props.pending}
      />

      <hr />

      <div className="grid gap-3">
        <div>
          <div className="text-sm font-semibold">{t("probes.form.target")}</div>
        </div>
        {kind === "http" ? (
          <div className="grid gap-1.5">
            <SectionLabel>{t("probes.form.url")}</SectionLabel>
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error?.field === "url") setError(null);
              }}
              disabled={props.pending}
              placeholder="https://example.com/healthz"
              aria-invalid={error?.field === "url"}
            />
          </div>
        ) : kind === "tcp" ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <SectionLabel>{t("probes.form.host")}</SectionLabel>
              <Input
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  if (error?.field === "host") setError(null);
                }}
                disabled={props.pending}
                placeholder="1.1.1.1"
                aria-invalid={error?.field === "host"}
              />
            </div>
            <div className="grid gap-1.5">
              <SectionLabel>{t("probes.form.port")}</SectionLabel>
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                  if (error?.field === "port") setError(null);
                }}
                disabled={props.pending}
                placeholder="443"
                aria-invalid={error?.field === "port"}
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <SectionLabel>{t("probes.form.host")}</SectionLabel>
            <Input
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                if (error?.field === "host") setError(null);
              }}
              disabled={props.pending}
              placeholder="1.1.1.1"
              aria-invalid={error?.field === "host"}
            />
          </div>
        )}
      </div>

      {error ? (
        <div className="text-destructive text-sm" role="alert">
          {error.text}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={props.pending || !canSubmit}>
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
