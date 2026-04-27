import { Loader2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { LiveSocketStatus } from "@/live/client";

const RESTORED_DISPLAY_MS = 2000;

export function ConnectionBanner({ status }: { status: LiveSocketStatus }) {
  const { t } = useTranslation();

  // Show a brief "restored" message when transitioning from reconnecting → connected.
  const [showRestored, setShowRestored] = React.useState(false);
  const prevStatusRef = React.useRef(status);

  React.useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prev === "reconnecting" && status === "connected") {
      setShowRestored(true);
      const timer = window.setTimeout(() => setShowRestored(false), RESTORED_DISPLAY_MS);
      return () => window.clearTimeout(timer);
    }

    if (status === "reconnecting") {
      setShowRestored(false);
    }
  }, [status]);

  if (status === "reconnecting") {
    return (
      <div className="border-b border-amber-500/20 bg-amber-500/15 text-amber-700 dark:text-amber-400">
        <div className="container flex items-center justify-center gap-2 py-1.5 text-xs font-medium">
          <Loader2 className="size-3 animate-spin" />
          {t("live.disconnected")}
        </div>
      </div>
    );
  }

  if (showRestored) {
    return (
      <div className="border-b border-emerald-500/20 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        <div className="container flex items-center justify-center py-1.5 text-xs font-medium">
          {t("live.reconnected")}
        </div>
      </div>
    );
  }

  return null;
}
