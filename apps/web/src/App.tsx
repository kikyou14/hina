import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AuthStateSync } from "@/auth/AuthStateSync";
import { RequireAdmin } from "@/auth/RequireAdmin";
import { ConfirmDialogProvider } from "@/components/ConfirmDialog";
import { DocumentMeta } from "@/components/DocumentMeta";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SiteConfigProvider } from "@/components/SiteConfigProvider";
import { PageSkeleton } from "@/components/Skeletons";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Toaster } from "@/components/ui/sonner";
import { AdminLayout } from "@/pages/admin/AdminLayout";

const AgentsPage = React.lazy(async () =>
  import("@/pages/admin/AgentsPage").then((module) => ({
    default: module.AgentsPage,
  })),
);
const AccountPage = React.lazy(async () =>
  import("@/pages/admin/AccountPage").then((module) => ({
    default: module.AccountPage,
  })),
);
const AlertsPage = React.lazy(async () =>
  import("@/pages/admin/AlertsPage").then((module) => ({
    default: module.AlertsPage,
  })),
);
const AuditLoginsPage = React.lazy(async () =>
  import("@/pages/admin/AuditLoginsPage").then((module) => ({
    default: module.AuditLoginsPage,
  })),
);
const ProbeTasksPage = React.lazy(async () =>
  import("@/pages/admin/ProbeTasksPage").then((module) => ({
    default: module.ProbeTasksPage,
  })),
);
const SettingsPage = React.lazy(async () =>
  import("@/pages/admin/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const NotFoundPage = React.lazy(async () =>
  import("@/pages/NotFoundPage").then((module) => ({
    default: module.NotFoundPage,
  })),
);
const PublicAgentPage = React.lazy(async () =>
  import("@/pages/public/PublicAgentPage").then((module) => ({
    default: module.PublicAgentPage,
  })),
);
const PublicAgentsPage = React.lazy(async () =>
  import("@/pages/public/PublicAgentsPage").then((module) => ({
    default: module.PublicAgentsPage,
  })),
);

function RouteFallback() {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="container py-8">
        <PageSkeleton />
      </div>
    </div>
  );
}

function withSuspense(element: React.ReactNode) {
  return <React.Suspense fallback={<RouteFallback />}>{element}</React.Suspense>;
}

export default function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <SiteConfigProvider>
          <DocumentMeta />
          <BrowserRouter>
            <Toaster position="top-center" richColors />
            <AuthStateSync />
            <ConfirmDialogProvider>
              <Routes>
                <Route path="/" element={withSuspense(<PublicAgentsPage />)} />
                <Route path="/agents/:agentId" element={withSuspense(<PublicAgentPage />)} />

                <Route
                  path="/admin"
                  element={
                    <RequireAdmin>
                      <AdminLayout />
                    </RequireAdmin>
                  }
                >
                  <Route index element={<Navigate to="agents" replace />} />
                  <Route path="agents" element={withSuspense(<AgentsPage />)} />
                  <Route path="probes" element={withSuspense(<ProbeTasksPage />)} />
                  <Route path="probe-results" element={<Navigate to="/admin/probes" replace />} />
                  <Route
                    path="probe-results/:resultId"
                    element={<Navigate to="/admin/probes" replace />}
                  />
                  <Route path="alerts" element={withSuspense(<AlertsPage />)} />
                  <Route path="audit/logins" element={withSuspense(<AuditLoginsPage />)} />
                  <Route path="account" element={withSuspense(<AccountPage />)} />
                  <Route path="settings" element={withSuspense(<SettingsPage />)} />
                </Route>
                <Route path="*" element={withSuspense(<NotFoundPage />)} />
              </Routes>
            </ConfirmDialogProvider>
          </BrowserRouter>
        </SiteConfigProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
