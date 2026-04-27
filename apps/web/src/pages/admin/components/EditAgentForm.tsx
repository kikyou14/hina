import * as React from "react";
import { useTranslation } from "react-i18next";

import type { AdminAgent, BillingMode } from "@/api/adminAgents";
import type { patchAdminAgent } from "@/api/adminAgents";
import { PricingEditor, type PricingFormValues } from "@/components/PricingEditor";
import { TagEditor } from "@/components/TagEditor";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { parseBytes } from "@/lib/format";
import { getUserErrorMessage } from "@/lib/userErrors";
import {
  type EditFormField,
  buildEditPatch,
  formatQuotaInput,
  initEditFormValues,
} from "../lib/agentEditHelpers";

type EditFormError = { text: string; field: EditFormField | null };

export function EditAgentForm(props: {
  agent: AdminAgent;
  pending: boolean;
  onSave: (patch: Parameters<typeof patchAdminAgent>[1]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const uid = React.useId();
  const fid = (suffix: string) => `${uid}-${suffix}`;

  const init = React.useRef(initEditFormValues(props.agent));

  const [name, setName] = React.useState(init.current.name);
  const [groupName, setGroupName] = React.useState(init.current.groupName);
  const [isPublic, setIsPublic] = React.useState(init.current.isPublic);
  const [tags, setTags] = React.useState(init.current.tags);
  const [note, setNote] = React.useState(init.current.note);

  const [quotaInput, setQuotaInput] = React.useState(init.current.quotaInput);
  const [mode, setMode] = React.useState<BillingMode>(init.current.mode);
  const [resetDay, setResetDay] = React.useState(init.current.resetDay);

  const [pricing, setPricing] = React.useState<PricingFormValues>(init.current.pricing);

  const [error, setError] = React.useState<EditFormError | null>(null);

  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);

        const result = buildEditPatch(
          {
            name,
            groupName,
            isPublic,
            tags,
            note,
            quotaInput,
            quotaBytes: init.current.quotaBytes,
            mode,
            resetDay,
            pricing,
          },
          init.current,
        );

        if (result.kind === "noop") {
          props.onClose();
          return;
        }
        if (result.kind === "error") {
          setError({ text: t(result.key), field: result.field });
          return;
        }

        try {
          await props.onSave(result.patch);
        } catch (err) {
          setError({
            text: getUserErrorMessage(err, t, {
              action: "update",
              fallback: t("agents.form.updateFailed"),
            }),
            field: null,
          });
          return;
        }

        props.onClose();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={fid("name")}>{t("common.name")}</Label>
        <Input
          id={fid("name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={props.pending}
          maxLength={50}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={fid("group")}>{t("agents.form.groupByName")}</Label>
        <Input
          id={fid("group")}
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          disabled={props.pending}
          placeholder={t("common.optional")}
        />
      </div>

      <div className="grid gap-2">
        <Label>{t("agents.filters.tags")}</Label>
        <TagEditor tags={tags} onChange={setTags} disabled={props.pending} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={fid("note")}>{t("agents.form.note")}</Label>
        <Textarea
          id={fid("note")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={props.pending}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor={fid("public")} className="text-sm">
          {t("common.public")}
        </Label>
        <Switch
          id={fid("public")}
          checked={isPublic}
          onCheckedChange={setIsPublic}
          disabled={props.pending}
        />
      </div>

      <div className="grid gap-2">
        <Label>{t("agents.billingDialog.title")}</Label>
        <div className="grid gap-2 md:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor={fid("quota")} className="text-xs">
              {t("agents.billing.quota")}
            </Label>
            <Input
              id={fid("quota")}
              value={quotaInput}
              onChange={(e) => {
                setQuotaInput(e.target.value);
                if (error?.field === "quota") setError(null);
              }}
              onBlur={() => {
                const bytes = parseBytes(quotaInput);
                if (bytes !== null) setQuotaInput(formatQuotaInput(bytes));
              }}
              disabled={props.pending}
              placeholder={t("agents.billing.unlimitedPlaceholder")}
              aria-invalid={error?.field === "quota"}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={fid("mode")} className="text-xs">
              {t("agents.billing.mode")}
            </Label>
            <Select value={mode} onValueChange={(v) => setMode(v as BillingMode)}>
              <SelectTrigger id={fid("mode")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sum">{t("agents.billing.modeSum")}</SelectItem>
                <SelectItem value="rx">{t("agents.billing.modeRx")}</SelectItem>
                <SelectItem value="tx">{t("agents.billing.modeTx")}</SelectItem>
                <SelectItem value="max">{t("agents.billing.modeMax")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={fid("resetDay")} className="text-xs">
              {t("agents.billing.resetDay")}
            </Label>
            <Input
              id={fid("resetDay")}
              type="number"
              min={1}
              max={31}
              value={resetDay}
              onChange={(e) => {
                setResetDay(e.target.value);
                if (error?.field === "resetDay") setError(null);
              }}
              disabled={props.pending}
              placeholder={t("agents.billing.resetDayPlaceholder")}
              aria-invalid={error?.field === "resetDay"}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        <Label>{t("agents.pricing.title")}</Label>
        <PricingEditor
          pricing={pricing}
          onChange={(v) => {
            setPricing(v);
            if (error?.field === "pricingAmount" && v.amount !== pricing.amount) {
              setError(null);
            }
          }}
          disabled={props.pending}
          amountInvalid={error?.field === "pricingAmount"}
        />
      </div>

      {error ? (
        <div className="text-destructive text-sm" role="alert">
          {error.text}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={props.pending || !name.trim()}>
          {props.pending ? t("common.saving") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
