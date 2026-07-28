/** Session cookie is role-scoped so business/admin on same host:port pair don't collide. */
export function sessionCookieName(): string {
  const role = (process.env.SERVICE_ROLE ?? "business").toLowerCase();
  return role === "admin" ? "va_admin_session" : "va_session";
}

export const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
