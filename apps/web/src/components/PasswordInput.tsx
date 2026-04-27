import { Eye, EyeOff } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<React.ComponentProps<"input">, "type">;

export function PasswordInput({ className, disabled, ...props }: PasswordInputProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  const Icon = visible ? EyeOff : Eye;
  const label = visible ? t("common.hidePassword") : t("common.showPassword");

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        disabled={disabled}
        className={cn("pr-7", className)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 absolute inset-y-0 right-0 flex w-7 items-center justify-center rounded-r-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
