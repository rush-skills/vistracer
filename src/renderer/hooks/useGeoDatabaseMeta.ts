import { useQuery } from "@tanstack/react-query";
import type { GeoDatabaseMeta } from "@common/ipc";

export function useGeoDatabaseMeta() {
  return useQuery<GeoDatabaseMeta>({
    queryKey: ["geo-database-meta"],
    queryFn: async () => window.visTracer.getGeoDatabaseMeta(),
    staleTime: 1000 * 60
  });
}
