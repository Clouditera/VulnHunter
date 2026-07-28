import { useQuery } from "@tanstack/react-query";

export type ServiceRole = "business" | "admin" | "unknown";

/**
 * Detect which service role the SPA is talking to via GET /health.
 * admin-web → admin-api returns { role: "admin" }
 * business web → service returns { role: "business" }
 */
export function useServiceRole() {
  return useQuery({
    queryKey: ["service-role"],
    queryFn: async (): Promise<ServiceRole> => {
      try {
        const res = await fetch("/health", { credentials: "include" });
        if (!res.ok) return "unknown";
        const body = (await res.json().catch(() => null)) as { role?: string } | null;
        if (body?.role === "admin" || body?.role === "business") return body.role;
        return "unknown";
      } catch {
        return "unknown";
      }
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function isAdminEntry(role: ServiceRole | undefined): boolean {
  return role === "admin";
}
