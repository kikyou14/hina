import * as React from "react";
import { useTranslation } from "react-i18next";

import { TagEditor } from "@/components/TagEditor";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getUserErrorMessage } from "@/lib/userErrors";

export function CreateAgentForm(props: {
  pending: boolean;
  onSubmit: (v: {
    name: string;
    groupName?: string;
    isPublic?: boolean;
    tags?: string[];
    note?: string | null;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const uid = React.useId();
  const fid = (suffix: string) => `${uid}-${suffix}`;
  const [name, setName] = React.useState("");
  const [groupName, setGroupName] = React.useState("");
  const [isPublic, setIsPublic] = React.useState(true);
  const [tags, setTags] = React.useState<string[]>([]);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await props.onSubmit({
            name: name.trim(),
            groupName: groupName.trim() || undefined,
            isPublic,
            tags,
            note: note.trim() ? note : null,
          });
        } catch (err) {
          setError(
            getUserErrorMessage(err, t, {
              action: "create",
              fallback: t("agents.form.createFailed"),
            }),
          );
        }
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
          placeholder={t("common.optional")}
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
      {error ? (
        <div className="text-destructive text-sm" role="alert">
          {error}
        </div>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={props.pending || !name.trim()}>
          {props.pending ? t("common.creating") : t("common.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
