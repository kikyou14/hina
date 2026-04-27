import * as React from "react";
import { useTranslation } from "react-i18next";

import { AgentPickerDialog } from "@/components/AgentPickerDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { SectionLabel } from "@/pages/admin/components/SectionLabel";

export type ScopeMode = "all" | "groups" | "specific";

export type ScopeState = {
  mode: ScopeMode;
  groupIds: string[];
  agentIds: string[];
};

export function ScopeSelector(props: {
  agents: Array<{ id: string; name: string; group: string | null }>;
  groups: Array<{ id: string; name: string }>;
  scope: ScopeState;
  onScopeChange: (scope: ScopeState) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const setMode = (mode: ScopeMode) => {
    props.onScopeChange({ ...props.scope, mode });
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <SectionLabel>{t("scope.label")}</SectionLabel>
        <Select value={props.scope.mode} onValueChange={(v) => setMode(v as ScopeMode)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("scope.modes.all")}</SelectItem>
            <SelectItem value="groups">{t("scope.modes.groups")}</SelectItem>
            <SelectItem value="specific">{t("scope.modes.specific")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {props.scope.mode === "all" ? (
        <div className="text-muted-foreground text-xs">{t("scope.allDescription")}</div>
      ) : null}

      {props.scope.mode === "groups" ? (
        <div className="space-y-1.5">
          {props.groups.length === 0 ? (
            <div className="text-muted-foreground text-xs">{t("scope.noGroups")}</div>
          ) : null}
          {props.groups.map((g) => {
            const checked = props.scope.groupIds.includes(g.id);
            const agentCount = props.agents.filter((a) => a.group === g.name).length;
            return (
              <label
                key={g.id}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md border p-2.5 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={checked}
                    disabled={props.disabled}
                    onCheckedChange={(v) =>
                      props.onScopeChange({
                        ...props.scope,
                        groupIds: v
                          ? [...props.scope.groupIds, g.id]
                          : props.scope.groupIds.filter((x) => x !== g.id),
                      })
                    }
                  />
                  <span>{g.name}</span>
                </div>
                <Badge variant="outline">{t("scope.agentCount", { count: agentCount })}</Badge>
              </label>
            );
          })}
        </div>
      ) : null}

      {props.scope.mode === "specific" ? (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs">
            {props.scope.agentIds.length > 0
              ? t("settings.ruleForm.agents.selected", { count: props.scope.agentIds.length })
              : t("settings.ruleForm.agents.none")}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPickerOpen(true)}
            disabled={props.disabled}
          >
            {t("settings.ruleForm.agents.select")}
          </Button>
        </div>
      ) : null}

      {props.scope.mode === "specific" ? (
        <AgentPickerDialog
          open={pickerOpen}
          agents={props.agents}
          selected={props.scope.agentIds}
          onConfirm={(ids) => {
            props.onScopeChange({ ...props.scope, agentIds: ids });
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
