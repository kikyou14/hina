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
  isTcpTracerouteTarget,
  isValidHost,
  isValidHttpUrl,
  isValidPort,
  isValidTracerouteTcpPacketSize,
  parseIntegerInput,
  parseTracerouteTcpPacketSizes,
  TRACEROUTE_TCP_PACKET_SIZE_MAX,
  TRACEROUTE_TCP_PACKET_SIZE_MIN,
  tracerouteProtocolOfTarget,
  type ProbeTaskFormValue,
  type TracerouteProtocol,
} from "../lib/probeValidation";
import { SectionLabel } from "./SectionLabel";

type ProbeFormField =
  | "intervalSec"
  | "timeoutMs"
  | "url"
  | "host"
  | "port"
  | "smallSize"
  | "largeSize";
type ProbeFormError = { text: string; field: ProbeFormField | null };

const TARGET_FORM_FIELDS: readonly ProbeFormField[] = [
  "url",
  "host",
  "port",
  "smallSize",
  "largeSize",
];
const TCP_TRACEROUTE_ONLY_FIELDS: readonly ProbeFormField[] = ["port", "smallSize", "largeSize"];

const DEFAULT_TCP_TRACEROUTE_PORT = "443";
const DEFAULT_SMALL_PACKET_SIZE = "64";
const DEFAULT_LARGE_PACKET_SIZE = "1400";

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

  const initialTarget = tsk?.target ?? null;
  const initialHost = initialTarget && "host" in initialTarget ? String(initialTarget.host) : "";
  const initialPort = initialTarget && "port" in initialTarget ? String(initialTarget.port) : "";
  const initialUrl = initialTarget && "url" in initialTarget ? String(initialTarget.url) : "";
  const initialTcpTraceroute = isTcpTracerouteTarget(initialTarget) ? initialTarget : null;

  const [host, setHost] = React.useState(initialHost);
  const [port, setPort] = React.useState(initialPort);
  const [url, setUrl] = React.useState(initialUrl);
  const [tracerouteProtocol, setTracerouteProtocol] = React.useState<TracerouteProtocol>(() =>
    tracerouteProtocolOfTarget(initialTarget),
  );
  const [tracerouteTcpPort, setTracerouteTcpPort] = React.useState(
    initialTcpTraceroute ? String(initialTcpTraceroute.port) : DEFAULT_TCP_TRACEROUTE_PORT,
  );
  const [smallSize, setSmallSize] = React.useState(
    initialTcpTraceroute ? String(initialTcpTraceroute.packetSizes[0]) : DEFAULT_SMALL_PACKET_SIZE,
  );
  const [largeSize, setLargeSize] = React.useState(
    initialTcpTraceroute ? String(initialTcpTraceroute.packetSizes[1]) : DEFAULT_LARGE_PACKET_SIZE,
  );

  const [scope, setScope] = React.useState<ScopeState>(() => initScopeFromTask(tsk));

  const [error, setError] = React.useState<ProbeFormError | null>(null);

  function clearErrorForFields(fields: readonly ProbeFormField[]) {
    if (error && error.field !== null && fields.includes(error.field)) {
      setError(null);
    }
  }

  const target: ProbeTaskTarget | null = React.useMemo(() => {
    if (kind === "http") {
      return url.trim() ? { url: url.trim() } : null;
    }
    if (kind === "tcp") {
      const p = parseIntegerInput(port);
      if (!host.trim() || p === null) return null;
      return { host: host.trim(), port: p };
    }
    if (kind === "traceroute" && tracerouteProtocol === "tcp") {
      if (!host.trim()) return null;
      const p = parseIntegerInput(tracerouteTcpPort);
      const small = parseIntegerInput(smallSize);
      const large = parseIntegerInput(largeSize);
      if (p === null || small === null || large === null) return null;
      const packetSizes = parseTracerouteTcpPacketSizes(small, large);
      if (!packetSizes) return null;
      return { host: host.trim(), protocol: "tcp", port: p, packetSizes };
    }
    return host.trim() ? { host: host.trim() } : null;
  }, [kind, host, port, url, tracerouteProtocol, tracerouteTcpPort, smallSize, largeSize]);

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
          const interval = parseIntegerInput(intervalSec);
          const timeout = parseIntegerInput(timeoutMs);
          if (interval === null || interval < 1 || interval > 86400) {
            setError({ text: t("probes.form.invalidInterval"), field: "intervalSec" });
            return;
          }
          if (timeout === null || timeout < 100 || timeout > 120_000) {
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
            const p = parseIntegerInput(port);
            if (p === null || p < 1 || p > 65535) {
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
            if (kind === "traceroute" && tracerouteProtocol === "tcp") {
              const p = parseIntegerInput(tracerouteTcpPort);
              if (p === null || !isValidPort(p)) {
                setError({ text: t("probes.form.invalidPort"), field: "port" });
                return;
              }
              const small = parseIntegerInput(smallSize);
              if (small === null || !isValidTracerouteTcpPacketSize(small)) {
                setError({ text: t("probes.form.invalidPacketSize"), field: "smallSize" });
                return;
              }
              const large = parseIntegerInput(largeSize);
              if (large === null || !isValidTracerouteTcpPacketSize(large)) {
                setError({ text: t("probes.form.invalidPacketSize"), field: "largeSize" });
                return;
              }
              const packetSizes = parseTracerouteTcpPacketSizes(small, large);
              if (!packetSizes) {
                setError({ text: t("probes.form.duplicatePacketSizes"), field: "largeSize" });
                return;
              }
              validTarget = { host: trimmedHost, protocol: "tcp", port: p, packetSizes };
            } else {
              validTarget = { host: trimmedHost };
            }
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
              clearErrorForFields(TARGET_FORM_FIELDS);
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
        ) : kind === "traceroute" ? (
          <div className="grid gap-3">
            <div className="grid min-w-0 gap-1.5">
              <SectionLabel>{t("probes.form.tracerouteProtocol")}</SectionLabel>
              <Select
                value={tracerouteProtocol}
                onValueChange={(v) => {
                  const nextProtocol = v as TracerouteProtocol;
                  setTracerouteProtocol(nextProtocol);
                  if (nextProtocol === "icmp") clearErrorForFields(TCP_TRACEROUTE_ONLY_FIELDS);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="icmp">{t("probes.form.tracerouteProtocolIcmp")}</SelectItem>
                  <SelectItem value="tcp">{t("probes.form.tracerouteProtocolTcp")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
            {tracerouteProtocol === "tcp" ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="grid gap-1.5">
                    <SectionLabel>{t("probes.form.port")}</SectionLabel>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={tracerouteTcpPort}
                      onChange={(e) => {
                        setTracerouteTcpPort(e.target.value);
                        if (error?.field === "port") setError(null);
                      }}
                      disabled={props.pending}
                      placeholder={DEFAULT_TCP_TRACEROUTE_PORT}
                      aria-invalid={error?.field === "port"}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <SectionLabel>{t("probes.form.tracerouteSmallSize")}</SectionLabel>
                    <Input
                      type="number"
                      min={TRACEROUTE_TCP_PACKET_SIZE_MIN}
                      max={TRACEROUTE_TCP_PACKET_SIZE_MAX}
                      value={smallSize}
                      onChange={(e) => {
                        setSmallSize(e.target.value);
                        if (error?.field === "smallSize") setError(null);
                      }}
                      disabled={props.pending}
                      placeholder={DEFAULT_SMALL_PACKET_SIZE}
                      aria-invalid={error?.field === "smallSize"}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <SectionLabel>{t("probes.form.tracerouteLargeSize")}</SectionLabel>
                    <Input
                      type="number"
                      min={TRACEROUTE_TCP_PACKET_SIZE_MIN}
                      max={TRACEROUTE_TCP_PACKET_SIZE_MAX}
                      value={largeSize}
                      onChange={(e) => {
                        setLargeSize(e.target.value);
                        if (error?.field === "largeSize") setError(null);
                      }}
                      disabled={props.pending}
                      placeholder={DEFAULT_LARGE_PACKET_SIZE}
                      aria-invalid={error?.field === "largeSize"}
                    />
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t("probes.form.tracerouteSizeHint")}
                </p>
              </>
            ) : null}
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
