import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";

import type { AdminMeResponse } from "@/api/admin";
import {
  adminMeOptionalQueryKey,
  clearPrivilegedCache,
  invalidatePublicQueries,
  useOptionalAdminMe,
} from "@/queries/admin";

const lastReconciledUserId: { current: string | null | undefined } = { current: undefined };

export function AuthStateSync() {
  const queryClient = useQueryClient();
  const me = useOptionalAdminMe();

  const confirmedUserId: string | null | undefined = me.isSuccess
    ? (me.data.user?.id ?? null)
    : undefined;

  React.useEffect(() => {
    if (confirmedUserId === undefined) return;
    const prev = lastReconciledUserId.current;
    lastReconciledUserId.current = confirmedUserId;
    if (prev === confirmedUserId) return;

    if (confirmedUserId !== null) {
      void invalidatePublicQueries(queryClient);
      return;
    }
    if (prev !== undefined && prev !== null) {
      clearPrivilegedCache(queryClient);
    }
  }, [confirmedUserId, queryClient]);

  return null;
}

export function reconcileExplicitLogout(queryClient: QueryClient) {
  clearPrivilegedCache(queryClient);
  const guestMe: AdminMeResponse = { ok: true, user: null };
  queryClient.setQueryData(adminMeOptionalQueryKey, guestMe);
  lastReconciledUserId.current = null;
}
