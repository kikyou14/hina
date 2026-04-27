import * as React from "react";

import { LoginDialog } from "@/components/LoginDialog";
import { PageSkeleton } from "@/components/Skeletons";
import { useAdminMe } from "@/queries/admin";

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const me = useAdminMe();

  if (me.isLoading) {
    return (
      <div className="bg-background text-foreground min-h-screen">
        <div className="container py-12">
          <PageSkeleton />
        </div>
      </div>
    );
  }

  if (me.data?.user) return <>{children}</>;

  return (
    <div className="bg-background text-foreground min-h-screen">
      <LoginDialog open />
    </div>
  );
}
