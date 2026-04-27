import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

export type ChartPlaceholderStatus = "loading" | "empty" | "error";

export type ChartPlaceholderProps = {
  status: ChartPlaceholderStatus;
  message?: string;
  className?: string;
};

const ICONS: Record<ChartPlaceholderStatus, React.ComponentType<{ className?: string }>> = {
  loading: Loader2,
  empty: Inbox,
  error: AlertTriangle,
};

export const ChartPlaceholder = React.memo(function ChartPlaceholder(props: ChartPlaceholderProps) {
  const { t } = useTranslation();
  const Icon = ICONS[props.status];

  const defaultMessage =
    props.status === "loading"
      ? t("common.loading")
      : props.status === "error"
        ? t("common.error")
        : t("common.noData");

  const message = props.message ?? defaultMessage;
  const tone = props.status === "error" ? "text-destructive" : "text-muted-foreground";
  const iconClass = props.status === "loading" ? "size-5 animate-spin" : "size-5 opacity-70";

  return (
    <div
      className={`flex h-full w-full items-center justify-center gap-2 text-xs ${tone} ${props.className ?? ""}`}
      role="status"
      aria-live="polite"
    >
      <Icon className={iconClass} />
      <span>{message}</span>
    </div>
  );
});
