import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function AgentPickerDialog(props: {
  open: boolean;
  agents: Array<{ id: string; name: string; group: string | null }>;
  selected: string[];
  onConfirm: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState<string[]>(props.selected);
  const [query, setQuery] = React.useState("");

  const prevOpen = React.useRef(false);
  React.useEffect(() => {
    if (props.open && !prevOpen.current) {
      setDraft(props.selected);
      setQuery("");
    }
    prevOpen.current = props.open;
  }, [props.open, props.selected]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.agents;
    return props.agents.filter((a) => `${a.name} ${a.group ?? ""}`.toLowerCase().includes(q));
  }, [props.agents, query]);

  const draftSet = React.useMemo(() => new Set(draft), [draft]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => draftSet.has(a.id));

  const toggleAll = () => {
    if (allFilteredSelected) {
      const removeSet = new Set(filtered.map((a) => a.id));
      setDraft(draft.filter((id) => !removeSet.has(id)));
    } else {
      const next = new Set(draftSet);
      for (const a of filtered) next.add(a.id);
      setDraft([...next]);
    }
  };

  if (!props.open) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(e) => {
          e.stopPropagation();
        }}
        onPointerDownOutside={(e) => {
          e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("settings.ruleForm.agents.pickerTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.ruleForm.agents.selected", { count: draft.length })}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.ruleForm.agents.searchPlaceholder")}
        />
        <div className="max-h-64 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allFilteredSelected} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("settings.ruleForm.agents.group")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((a) => {
                const checked = draftSet.has(a.id);
                return (
                  <TableRow
                    key={a.id}
                    className="cursor-pointer"
                    onClick={() =>
                      setDraft(checked ? draft.filter((x) => x !== a.id) : [...draft, a.id])
                    }
                  >
                    <TableCell>
                      <Checkbox checked={checked} tabIndex={-1} />
                    </TableCell>
                    <TableCell className="text-sm">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {a.group || "\u2014"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => props.onConfirm(draft)}>
            {t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
