import { Settings } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import { LanguageToggle } from "@/components/LanguageToggle";
import { LoginDialog } from "@/components/LoginDialog";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOptionalAdminMe } from "@/queries/admin";

interface PublicHeaderProps {
  left?: React.ReactNode;
  className?: string;
  containerClassName?: string;
}

export function PublicHeader({ left, className, containerClassName }: PublicHeaderProps) {
  const { t } = useTranslation();
  const { siteName } = useSiteConfig();
  const navigate = useNavigate();
  const me = useOptionalAdminMe();
  const isLoggedIn = Boolean(me.data?.user);
  const [loginOpen, setLoginOpen] = React.useState(false);
  const portalLabel = t("common.adminPortal");

  return (
    <header className={cn("hina-public-header border-b", className)}>
      <div
        className={cn(containerClassName ?? "container", "flex h-14 items-center justify-between")}
      >
        {left ?? (
          <Link to="/" className="font-semibold">
            {siteName}
          </Link>
        )}
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
          {isLoggedIn ? (
            <Button variant="outline" size="icon" className="size-8" asChild title={portalLabel}>
              <Link to="/admin" aria-label={portalLabel}>
                <Settings className="size-4" />
                <span className="sr-only">{portalLabel}</span>
              </Link>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => setLoginOpen(true)}
              aria-label={portalLabel}
              title={portalLabel}
            >
              <Settings className="size-4" />
              <span className="sr-only">{portalLabel}</span>
            </Button>
          )}
        </div>
      </div>
      <LoginDialog
        open={loginOpen}
        onOpenChange={setLoginOpen}
        onSuccess={() => {
          setLoginOpen(false);
          navigate("/admin");
        }}
      />
    </header>
  );
}
