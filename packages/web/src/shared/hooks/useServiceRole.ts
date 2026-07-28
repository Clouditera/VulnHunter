import { useQuery } from "@tanstack/react-query";

export type ServiceRole = "business" | "admin" | "unknown";

/**
 * Detect admin-web vs business-web entry.
 *
 * `/health` is NOT proxied by either nginx (only `/api/`), so we probe an
 * admin-only path that is mounted solely on admin-api:
 *   - business service: 404 (route not mounted)
 *   - admin-api: 200 / 401 / 403 (route exists; auth may fail)
 * HTML SPA fallback responses are treated as business/unknown.
 */
export function useServiceRole() {
  return useQuery({
    queryKey: ["service-role"],
    queryFn: async (): Promise<ServiceRole> => {
      try {
        const res = await fetch("/api/admin/system-config", {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        // Route missing on business service
        if (res.status === 404) return "business";

        const ct = res.headers.get("content-type") || "";
        // SPA index.html fallback (nginx try_files) — not JSON API
        if (ct.includes("text/html")) return "business";

        // admin-api mounted the route (auth may still reject)
        if (res.status === 200 || res.status === 401 || res.status === 403) {
          return "admin";
        }

        // Other JSON errors from a live admin router
        if (ct.includes("application/json")) return "admin";

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
