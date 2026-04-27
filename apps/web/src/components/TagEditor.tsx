import { Cancel01Icon, Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { TagBadge } from "@/components/TagBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TagEditor({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = React.useState(false);
  const [input, setInput] = React.useState("");

  const handleAdd = () => {
    const newTags = input
      .split(";")
      .map((s) => s.trim().replace(/<([^>]+)>$/, (_, m: string) => `<${m.replace(/\s+/g, "")}>`))
      .filter((s) => s && !tags.includes(s));
    if (newTags.length === 0) return;
    onChange([...tags, ...newTags]);
    setInput("");
    setAdding(false);
  };

  const handleRemove = (index: number) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  return (
    <div className="grid gap-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag, i) => (
            <span key={tag} className="group relative">
              <TagBadge tag={tag} />
              {!disabled && (
                <button
                  type="button"
                  aria-label={t("agents.tags.remove", { tag })}
                  onClick={() => handleRemove(i)}
                  className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full transition-opacity focus-visible:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100"
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={3} className="size-2" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {adding ? (
        <div className="border-border grid gap-2 rounded-md border p-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="CN2<blue,route>; NAT<orange>"
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              onClick={handleAdd}
              disabled={disabled || !input.trim()}
            >
              {t("agents.tags.addButton")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setAdding(false)}
              disabled={disabled}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setAdding(true)}
          disabled={disabled}
          className="w-fit"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-3" />
          {t("agents.tags.add")}
        </Button>
      )}
    </div>
  );
}
