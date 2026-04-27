import { useQuery } from "@tanstack/react-query";

import {
  getAdminActiveAlerts,
  getAdminAlertChannelOptions,
  getAdminAlertChannels,
  getAdminAlertNotifications,
  getAdminAlertRules,
} from "@/api/adminAlerts";

export function useAdminAlertChannels(query?: { limit?: number; offset?: number }) {
  const limit = query?.limit;
  const offset = query?.offset;
  return useQuery({
    queryKey: ["admin", "alertChannels", { limit, offset }],
    queryFn: () => getAdminAlertChannels({ limit, offset }),
    staleTime: 10_000,
  });
}

export function useAdminAlertChannelOptions() {
  return useQuery({
    queryKey: ["admin", "options", "alertChannels"],
    queryFn: getAdminAlertChannelOptions,
    staleTime: 30_000,
  });
}

export function useAdminAlertRules(query?: { limit?: number; offset?: number }) {
  const limit = query?.limit;
  const offset = query?.offset;
  return useQuery({
    queryKey: ["admin", "alertRules", { limit, offset }],
    queryFn: () => getAdminAlertRules({ limit, offset }),
    staleTime: 10_000,
  });
}

export function useAdminActiveAlerts() {
  return useQuery({
    queryKey: ["admin", "activeAlerts"],
    queryFn: () => getAdminActiveAlerts(200),
    staleTime: 3_000,
    refetchInterval: 10_000,
  });
}

export function useAdminAlertNotifications(status?: string) {
  return useQuery({
    queryKey: ["admin", "alertNotifications", status ?? ""],
    queryFn: () => getAdminAlertNotifications({ status, limit: 200 }),
    staleTime: 3_000,
    refetchInterval: 10_000,
  });
}
