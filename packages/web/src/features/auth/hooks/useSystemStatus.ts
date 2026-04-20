import { useQuery } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";

export function useSystemStatus() {
  return useQuery({
    queryKey: ["system-status"],
    queryFn: api.system.status,
    staleTime: 10_000, // 10s
    retry: 1,
  });
}
