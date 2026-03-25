import { useQuery } from "@tanstack/react-query";
import type { RecentRun } from "@common/ipc";

export function useRecentRuns() {
  return useQuery<RecentRun[]>({
    queryKey: ["recent-runs"],
    queryFn: async () => {
      const runs = await window.visTracer.getRecentRuns();
      return runs;
    },
    staleTime: 1000 * 30
  });
}
