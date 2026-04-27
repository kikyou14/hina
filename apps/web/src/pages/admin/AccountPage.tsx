import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useAdminMe } from "@/queries/admin";
import { PasswordSection } from "./components/PasswordSection";
import { UsernameSection } from "./components/UsernameSection";

function AccountPageSkeleton() {
  const fieldSkeleton = (
    <div className="grid gap-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-9 w-full" />
    </div>
  );

  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-28" />
      {/* UsernameSection card */}
      <div className="border-border space-y-4 rounded-lg border p-6">
        <Skeleton className="h-5 w-32" />
        <div className="grid gap-4">
          {fieldSkeleton}
          {fieldSkeleton}
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      {/* PasswordSection card */}
      <div className="border-border space-y-4 rounded-lg border p-6">
        <Skeleton className="h-5 w-28" />
        <div className="grid gap-4">
          {fieldSkeleton}
          {fieldSkeleton}
          {fieldSkeleton}
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
    </div>
  );
}

export function AccountPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("account.title"));
  const me = useAdminMe();

  if (me.isLoading) {
    return <AccountPageSkeleton />;
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-lg font-semibold">{t("account.title")}</div>
      </div>
      <UsernameSection />
      <PasswordSection />
    </div>
  );
}
