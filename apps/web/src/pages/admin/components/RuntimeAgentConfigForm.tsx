import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getUserErrorMessage } from "@/lib/userErrors";

export function RuntimeAgentConfigForm(props: {
  current: {
    telemetryIntervalMs: number;
    telemetryJitterMs: number;
  };
  defaults: {
    telemetryIntervalMs: number;
    telemetryJitterMs: number;
  };
  source: {
    telemetryIntervalMs: string;
    telemetryJitterMs: string;
  };
  pending: boolean;
  onSubmit: (patch: { telemetryIntervalMs: number; telemetryJitterMs: number }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [telemetryIntervalMs, setTelemetryIntervalMs] = React.useState(
    String(props.current.telemetryIntervalMs),
  );
  const [telemetryJitterMs, setTelemetryJitterMs] = React.useState(
    String(props.current.telemetryJitterMs),
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setTelemetryIntervalMs(String(props.current.telemetryIntervalMs));
    setTelemetryJitterMs(String(props.current.telemetryJitterMs));
  }, [props.current.telemetryIntervalMs, props.current.telemetryJitterMs]);

  return (
    <form
      className="grid gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          const nextTelemetryIntervalMs = Number.parseInt(telemetryIntervalMs, 10);
          const nextTelemetryJitterMs = Number.parseInt(telemetryJitterMs, 10);

          if (
            !Number.isFinite(nextTelemetryIntervalMs) ||
            nextTelemetryIntervalMs < 1000 ||
            nextTelemetryIntervalMs > 3_600_000
          ) {
            setError(t("settings.runtime.telemetryIntervalError"));
            return;
          }
          if (
            !Number.isFinite(nextTelemetryJitterMs) ||
            nextTelemetryJitterMs < 0 ||
            nextTelemetryJitterMs > 600_000
          ) {
            setError(t("settings.runtime.telemetryJitterError"));
            return;
          }

          await props.onSubmit({
            telemetryIntervalMs: nextTelemetryIntervalMs,
            telemetryJitterMs: nextTelemetryJitterMs,
          });
        } catch (err) {
          setError(
            getUserErrorMessage(err, t, {
              action: "update",
              fallback: t("settings.runtime.updateFailed"),
            }),
          );
        }
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label>{t("settings.runtime.telemetryInterval")}</Label>
          <Input
            value={telemetryIntervalMs}
            onChange={(e) => setTelemetryIntervalMs(e.target.value)}
            disabled={props.pending}
          />
          <div className="text-muted-foreground text-xs">
            {t("settings.runtime.default")} {props.defaults.telemetryIntervalMs} ·{" "}
            {t("settings.runtime.source")} {props.source.telemetryIntervalMs}
          </div>
        </div>
        <div className="grid gap-2">
          <Label>{t("settings.runtime.telemetryJitter")}</Label>
          <Input
            value={telemetryJitterMs}
            onChange={(e) => setTelemetryJitterMs(e.target.value)}
            disabled={props.pending}
          />
          <div className="text-muted-foreground text-xs">
            {t("settings.runtime.default")} {props.defaults.telemetryJitterMs} ·{" "}
            {t("settings.runtime.source")} {props.source.telemetryJitterMs}
          </div>
        </div>
      </div>

      {error ? (
        <div className="text-destructive text-sm" role="alert">
          {error}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={props.pending}>
          {props.pending ? t("common.saving") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
