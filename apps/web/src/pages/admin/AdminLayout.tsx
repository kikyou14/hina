import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";

import { adminLogout } from "@/api/admin";
import { reconcileExplicitLogout } from "@/auth/AuthStateSync";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAdminLiveSync } from "@/live/admin";

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "hover:bg-accent hover:text-accent-foreground flex items-center rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap",
          isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
        )
      }
      end
    >
      {label}
    </NavLink>
  );
}

export function AdminLayout() {
  const { t } = useTranslation();
  const { siteName } = useSiteConfig();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { status: liveStatus } = useAdminLiveSync();

  const logout = useMutation({
    mutationFn: adminLogout,
    onSuccess() {
      reconcileExplicitLogout(queryClient);
      navigate("/", { replace: true });
    },
  });

  return (
    <div className="bg-background text-foreground min-h-screen">
      <ConnectionBanner status={liveStatus} />
      <header className="border-b">
        <div className="container flex h-14 items-center gap-6">
          <Link to="/" className="hidden w-55 shrink-0 px-3 font-semibold md:block">
            {siteName}
          </Link>
          <Link to="/" className="px-3 font-semibold md:hidden">
            {siteName}
          </Link>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <LanguageToggle />
            <ThemeToggle />
            <Button
              variant="outline"
              size="icon"
              className="size-8 cursor-pointer"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              aria-label={t("common.logout")}
              title={t("common.logout")}
            >
              <LogOut className="size-4" />
              <span className="sr-only">{t("common.logout")}</span>
            </Button>
          </div>
        </div>
      </header>

      <nav className="border-b md:hidden">
        <div className="container flex gap-1 overflow-x-auto py-2">
          <NavItem to="/admin/agents" label={t("admin.nav.agents")} />
          <NavItem to="/admin/probes" label={t("admin.nav.probeTasks")} />
          <NavItem to="/admin/alerts" label={t("admin.nav.alerts")} />
          <NavItem to="/admin/audit/logins" label={t("admin.nav.auditLogins")} />
          <NavItem to="/admin/account" label={t("admin.nav.account")} />
          <NavItem to="/admin/settings" label={t("admin.nav.settings")} />
        </div>
      </nav>

      <div className="container grid gap-6 py-8 md:grid-cols-[220px_1fr]">
        <aside className="hidden space-y-2 md:block">
          <NavItem to="/admin/agents" label={t("admin.nav.agents")} />
          <NavItem to="/admin/probes" label={t("admin.nav.probeTasks")} />
          <NavItem to="/admin/alerts" label={t("admin.nav.alerts")} />
          <NavItem to="/admin/audit/logins" label={t("admin.nav.auditLogins")} />
          <NavItem to="/admin/account" label={t("admin.nav.account")} />
          <NavItem to="/admin/settings" label={t("admin.nav.settings")} />
        </aside>
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
