/**
 * Auth helpers for WebSocket upgrade paths.
 * Cookie name is SERVICE_ROLE-scoped (va_session / va_admin_session).
 */

import type { IncomingMessage } from "node:http";
import { resolveSession } from "./features/auth/service.js";
import { sessionCookieName } from "./features/auth/session-cookie.js";
import type { SessionUser } from "./features/auth/types.js";

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}

/** Resolve authenticated user from upgrade request cookies. */
export async function resolveUserFromUpgrade(req: IncomingMessage): Promise<SessionUser | null> {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sid = cookies[sessionCookieName()];
  if (!sid) return null;
  const user = await resolveSession(sid);
  return user as SessionUser | null;
}

/** Write a minimal HTTP error and destroy the raw socket (pre-upgrade). */
export function rejectUpgrade(
  socket: { write: (s: string) => void; destroy: () => void },
  status: 401 | 403,
  reason: string,
): void {
  const body = status === 401 ? "Unauthorized" : "Forbidden";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
  );
  socket.destroy();
}
