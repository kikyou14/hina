import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";

import { toast } from "sonner";

// Reorders the visible page optimistically so a dropped row stays where it was
// dropped while the request is in flight; rolls back and toasts on failure.
export function useReorderMutation<K extends string>({
  listKey,
  queryKey,
  field,
  mutationFn,
  errorMessage,
}: {
  // Prefix shared by every page of the list, used to cancel and refetch.
  listKey: QueryKey;
  // Exact key of the page on screen.
  queryKey: QueryKey;
  field: K;
  mutationFn: (ids: string[]) => Promise<unknown>;
  errorMessage: string;
}) {
  type ListData = Record<K, Array<{ id: string }>>;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    async onMutate(ids) {
      await queryClient.cancelQueries({ queryKey: listKey });
      const prev = queryClient.getQueryData<ListData>(queryKey);
      if (prev) {
        const order = new Map(ids.map((id, i) => [id, i]));
        queryClient.setQueryData<ListData>(queryKey, {
          ...prev,
          [field]: [...prev[field]].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
        });
      }
      return { prev };
    },
    onError(_err, _ids, ctx) {
      if (ctx?.prev) {
        queryClient.setQueryData(queryKey, ctx.prev);
      }
      toast.error(errorMessage);
    },
    async onSettled() {
      await queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
}
