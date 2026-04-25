export interface SessionUser {
  userId: string;
  tenantId: string;
  email: string;
  role: "admin" | "member";
  displayName: string;
  sessionId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
  }
}
