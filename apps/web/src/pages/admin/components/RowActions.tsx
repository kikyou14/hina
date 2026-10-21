import { Ellipsis, Pencil, type LucideIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type RowMenuAction = {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
};

// Edit stays one click away; the rest lives in the overflow menu, where
// destructive items (passed last) get a separator above them.
export function RowActions({ onEdit, menu }: { onEdit: () => void; menu: RowMenuAction[] }) {
  const { t } = useTranslation();
  const firstDestructive = menu.findIndex((item) => item.destructive);

  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onEdit}
        aria-label={t("common.edit")}
        title={t("common.edit")}
      >
        <Pencil className="size-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("common.moreActions")}
            title={t("common.moreActions")}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          {menu.map((item, i) => (
            <React.Fragment key={item.label}>
              {i > 0 && i === firstDestructive ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                variant={item.destructive ? "destructive" : "default"}
                disabled={item.disabled}
                onSelect={item.onSelect}
              >
                <item.icon />
                {item.label}
              </DropdownMenuItem>
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
