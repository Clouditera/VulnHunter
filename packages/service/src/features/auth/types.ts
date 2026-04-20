export interface SessionUser {
  userId: string;
  tenantId: string;
  email: string;
  role: "admin" | "member";
  sessionId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
  }
}
