import type { SessionUser } from "../features/auth/types.js";

export interface QueryContext {
  tenantId: string;
  userId: string;
  role: "admin" | "member";
}

export function shouldFilterByUser(ctx: QueryContext): boolean {
  return ctx.role !== "admin";
}

export function queryContextFromUser(user: SessionUser): QueryContext {
  return {
    tenantId: user.tenantId,
    userId: user.userId,
    role: user.role,
  };
}
