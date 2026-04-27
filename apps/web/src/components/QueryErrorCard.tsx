import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getUserErrorMessage } from "@/lib/userErrors";
import { cn } from "@/lib/utils";

type QueryErrorCardProps = {
  error: unknown;
  className?: string;
  title?: string;
  description?: string;
  retrying?: boolean;
  onRetry?: () => void | Promise<unknown>;
};

export function QueryErrorCard({
  error,
  className,
  title,
  description,
  retrying = false,
  onRetry,
}: QueryErrorCardProps) {
  const { t } = useTranslation();
  const message = getUserErrorMessage(error, t, { action: "load" });

  return (
    <Card
      className={cn("border-destructive/25 bg-destructive/5", className)}
      role="alert"
      aria-live="polite"
    >
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            className="bg-destructive/10 text-destructive flex size-8 shrink-0 items-center justify-center rounded-md"
            aria-hidden="true"
          >
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0 space-y-1">
            <CardTitle>{title ?? t("common.failedToLoad")}</CardTitle>
            <CardDescription>{description ?? t("common.errors.loadDescription")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground text-sm">{message}</p>
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={() => {
              void onRetry();
            }}
          >
            <RefreshCw className={cn("size-3.5", retrying && "animate-spin")} />
            {retrying ? t("common.loading") : t("common.retry")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
