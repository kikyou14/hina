import * as React from "react";
import { useTranslation } from "react-i18next";

import type { AdminAgentOption } from "@/api/adminAgents";
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
  type FamilyChoice,
  familyConflictsWithHost,
  familyOfTarget,
  isTcpTracerouteTarget,
  isValidHost,
  isValidHttpUrl,
  isValidPort,
  isValidTcpPacketSize,
  parseIntegerInput,
  parseTracerouteTcpPacketSizes,
  probeCapabilitySupport,
  rawTcpFamily,
  requiredProbeCapabilities,
  TCP_PACKET_SIZE_MAX,
  TCP_PACKET_SIZE_MIN,
  tracerouteProtocolOfTarget,
  tcpPacketSizeOfTarget,
  withFamily,
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
  | "tcpPacketSize"
  | "smallSize"
  | "largeSize";
type ProbeFormError = { text: string; field: ProbeFormField | null };

/** `connect` completes a handshake through the OS; `syn` sends raw SYNs of an exact size. */
type TcpMode = "connect" | "syn";

const TARGET_FORM_FIELDS: readonly ProbeFormField[] = [
  "url",
  "host",
  "port",
  "tcpPacketSize",
  "smallSize",
  "largeSize",
];
const TCP_TRACEROUTE_ONLY_FIELDS: readonly ProbeFormField[] = ["port", "smallSize", "largeSize"];

const DEFAULT_TCP_TRACEROUTE_PORT = "443";
const DEFAULT_SMALL_PACKET_SIZE = "64";
const DEFAULT_LARGE_PACKET_SIZE = "1400";
const DEFAULT_TCP_PACKET_SIZE = 1400;
/** 1280 is the IPv6 minimum MTU, so it must always pass; larger sizes expose MTU problems. */
const TCP_PACKET_SIZE_PRESETS = [1280, 1400, 1500];

function FamilySelect(props: {
  value: FamilyChoice;
  onChange: (value: FamilyChoice) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-1.5">
      <SectionLabel>{t("probes.form.family")}</SectionLabel>
      <Select
        value={props.value}
        disabled={props.disabled}
        onValueChange={(v) => props.onChange(v as FamilyChoice)}
      >
        <SelectTrigger className="w-full" aria-label={t("probes.form.family")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t("probes.form.familyAuto")}</SelectItem>
          <SelectItem value="ipv4">{t("probes.form.familyIpv4")}</SelectItem>
          <SelectItem value="ipv6">{t("probes.form.familyIpv6")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

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
  agents: AdminAgentOption[];
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
  const initialTcpPacketSize = tcpPacketSizeOfTarget(initialTarget);

  const [family, setFamily] = React.useState<FamilyChoice>(() => familyOfTarget(initialTarget));
  const [tcpMode, setTcpMode] = React.useState<TcpMode>(
    initialTcpPacketSize === null ? "connect" : "syn",
  );
  const [tcpPacketSize, setTcpPacketSize] = React.useState(
    String(initialTcpPacketSize ?? DEFAULT_TCP_PACKET_SIZE),
  );

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

  const synSupport = probeCapabilitySupport(props.agents, scope, ["tcpPacketSize"]);
  const sizeFamily = rawTcpFamily(host, family);
  const minPacketSize = TCP_PACKET_SIZE_MIN[sizeFamily];

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
    const trimmedHost = host.trim();
    if (!trimmedHost) return null;
    if (kind === "tcp") {
      const p = parseIntegerInput(port);
      if (p === null) return null;
      if (tcpMode === "connect") return withFamily({ host: trimmedHost, port: p }, family);
      const size = parseIntegerInput(tcpPacketSize);
      if (size === null) return null;
      return withFamily({ host: trimmedHost, port: p, packetSize: size }, family);
    }
    if (kind === "traceroute" && tracerouteProtocol === "tcp") {
      const p = parseIntegerInput(tracerouteTcpPort);
      const small = parseIntegerInput(smallSize);
      const large = parseIntegerInput(largeSize);
      if (p === null || small === null || large === null) return null;
      const packetSizes = parseTracerouteTcpPacketSizes(
        small,
        large,
        rawTcpFamily(trimmedHost, family),
      );
      if (!packetSizes) return null;
      return withFamily(
        { host: trimmedHost, protocol: "tcp" as const, port: p, packetSizes },
        family,
      );
    }
    return withFamily({ host: trimmedHost }, family);
  }, [
    kind,
    host,
    port,
    url,
    family,
    tcpMode,
    tcpPacketSize,
    tracerouteProtocol,
    tracerouteTcpPort,
    smallSize,
    largeSize,
  ]);

  const requiredCapabilities = requiredProbeCapabilities(kind, target);
  const capabilitySupport = probeCapabilitySupport(props.agents, scope, requiredCapabilities);

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
          } else {
            // icmp / tcp / traceroute
            const trimmedHost = host.trim();
            if (!trimmedHost) {
              setError({ text: t("probes.form.missingTarget"), field: "host" });
              return;
            }
            if (!isValidHost(trimmedHost)) {
              setError({ text: t("probes.form.invalidHost"), field: "host" });
              return;
            }
            if (familyConflictsWithHost(trimmedHost, family)) {
              setError({ text: t("probes.form.familyConflict"), field: "host" });
              return;
            }
            const rawFamily = rawTcpFamily(trimmedHost, family);
            const invalidPacketSize = t("probes.form.invalidPacketSize", {
              min: TCP_PACKET_SIZE_MIN[rawFamily],
              max: TCP_PACKET_SIZE_MAX,
            });
            if (kind === "tcp") {
              const p = parseIntegerInput(port);
              if (p === null || !isValidPort(p)) {
                setError({ text: t("probes.form.invalidPort"), field: "port" });
                return;
              }
              if (tcpMode === "connect") {
                validTarget = withFamily({ host: trimmedHost, port: p }, family);
              } else {
                const size = parseIntegerInput(tcpPacketSize);
                if (size === null || !isValidTcpPacketSize(size, rawFamily)) {
                  setError({ text: invalidPacketSize, field: "tcpPacketSize" });
                  return;
                }
                validTarget = withFamily({ host: trimmedHost, port: p, packetSize: size }, family);
              }
            } else if (kind === "traceroute" && tracerouteProtocol === "tcp") {
              const p = parseIntegerInput(tracerouteTcpPort);
              if (p === null || !isValidPort(p)) {
                setError({ text: t("probes.form.invalidPort"), field: "port" });
                return;
              }
              const small = parseIntegerInput(smallSize);
              if (small === null || !isValidTcpPacketSize(small, rawFamily)) {
                setError({ text: invalidPacketSize, field: "smallSize" });
                return;
              }
              const large = parseIntegerInput(largeSize);
              if (large === null || !isValidTcpPacketSize(large, rawFamily)) {
                setError({ text: invalidPacketSize, field: "largeSize" });
                return;
              }
              const packetSizes = parseTracerouteTcpPacketSizes(small, large, rawFamily);
              if (!packetSizes) {
                setError({ text: t("probes.form.duplicatePacketSizes"), field: "largeSize" });
                return;
              }
              validTarget = withFamily(
                { host: trimmedHost, protocol: "tcp" as const, port: p, packetSizes },
                family,
              );
            } else {
              validTarget = withFamily({ host: trimmedHost }, family);
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
        ) : (
          <div className="grid gap-3">
            {kind === "traceroute" ? (
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
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid min-w-0 gap-1.5">
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
              <FamilySelect
                value={family}
                disabled={props.pending}
                onChange={(next) => {
                  setFamily(next);
                  clearErrorForFields(["host", "tcpPacketSize", "smallSize", "largeSize"]);
                }}
              />
            </div>
            {family === "auto" ? (
              <p className="text-muted-foreground text-xs">{t("probes.form.familyAutoHint")}</p>
            ) : null}
            {kind === "tcp" ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid min-w-0 gap-1.5">
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
                  <div className="grid min-w-0 gap-1.5">
                    <SectionLabel>{t("probes.form.tcpMode")}</SectionLabel>
                    <Select
                      value={tcpMode}
                      disabled={props.pending}
                      onValueChange={(v) => {
                        setTcpMode(v as TcpMode);
                        clearErrorForFields(["tcpPacketSize"]);
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label={t("probes.form.tcpMode")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="connect">{t("probes.form.tcpSystemConnect")}</SelectItem>
                        <SelectItem
                          value="syn"
                          disabled={synSupport.supported === 0 && tcpMode !== "syn"}
                        >
                          {t("probes.form.tcpSynMode")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {tcpMode === "syn" ? (
                  <div className="grid gap-1.5">
                    <SectionLabel>{t("probes.form.tcpPacketSizeBytes")}</SectionLabel>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="number"
                        className="w-28"
                        min={minPacketSize}
                        max={TCP_PACKET_SIZE_MAX}
                        value={tcpPacketSize}
                        onChange={(e) => {
                          setTcpPacketSize(e.target.value);
                          if (error?.field === "tcpPacketSize") setError(null);
                        }}
                        disabled={props.pending}
                        aria-label={t("probes.form.tcpPacketSizeBytes")}
                        aria-invalid={error?.field === "tcpPacketSize"}
                      />
                      {[minPacketSize, ...TCP_PACKET_SIZE_PRESETS].map((size) => (
                        <Button
                          key={size}
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={props.pending}
                          onClick={() => {
                            setTcpPacketSize(String(size));
                            if (error?.field === "tcpPacketSize") setError(null);
                          }}
                        >
                          {size === minPacketSize
                            ? t("probes.form.packetSizeMinPreset", { size })
                            : size}
                        </Button>
                      ))}
                    </div>
                    <p className="text-muted-foreground text-xs">{t("probes.form.tcpSynHint")}</p>
                  </div>
                ) : null}
              </>
            ) : null}
            {kind === "traceroute" && tracerouteProtocol === "tcp" ? (
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
                      min={minPacketSize}
                      max={TCP_PACKET_SIZE_MAX}
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
                      min={minPacketSize}
                      max={TCP_PACKET_SIZE_MAX}
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
            {requiredCapabilities.length > 0 ? (
              <p className="text-muted-foreground text-xs" role="status">
                {t("probes.form.capabilitySupport", capabilitySupport)}
              </p>
            ) : null}
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
