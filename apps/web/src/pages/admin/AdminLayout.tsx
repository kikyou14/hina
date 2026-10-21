import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  LogOut,
  Radar,
  Server,
  Settings,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
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

const NAV_ITEMS: { to: string; labelKey: string; icon: LucideIcon }[] = [
  { to: "/admin/agents", labelKey: "admin.nav.agents", icon: Server },
  { to: "/admin/probes", labelKey: "admin.nav.probeTasks", icon: Radar },
  { to: "/admin/alerts", labelKey: "admin.nav.alerts", icon: Bell },
  { to: "/admin/audit/logins", labelKey: "admin.nav.auditLogins", icon: ShieldCheck },
  { to: "/admin/account", labelKey: "admin.nav.account", icon: UserRound },
  { to: "/admin/settings", labelKey: "admin.nav.settings", icon: Settings },
];

function NavItem({ to, label, icon: Icon }: { to: string; label: string; icon: LucideIcon }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap",
          isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
        )
      }
      end
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
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

  const navItems = NAV_ITEMS.map((item) => (
    <NavItem key={item.to} to={item.to} label={t(item.labelKey)} icon={item.icon} />
  ));

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
          <Link to="/" className="font-semibold lg:w-55 lg:shrink-0">
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

      {/* The sidebar only appears from lg up: below that its 220px column would
          squeeze every admin page on tablets. */}
      <nav className="border-b lg:hidden">
        <div className="container flex gap-1 overflow-x-auto py-2">{navItems}</div>
      </nav>

      <div className="container grid gap-6 py-8 lg:grid-cols-[220px_1fr]">
        <aside className="hidden space-y-2 lg:sticky lg:top-8 lg:block lg:self-start">
          {navItems}
        </aside>
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
