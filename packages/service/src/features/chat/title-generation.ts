import { logger } from "../../infra/logger.js";
import { notify } from "../notifications/index.js";
import { getSession, listMessages, updateSessionTitleIfDefault } from "./storage.js";

const DEFAULT_TITLES = new Set(["", "New Chat", "新对话"]);
const TITLE_TIMEOUT_MS = 20_000;

export function isDefaultChatTitle(title: string | null | undefined): boolean {
  return DEFAULT_TITLES.has((title ?? "").trim());
}

export function sanitizeGeneratedTitle(raw: string): string {
  let title = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```$/g, "")
    .trim()
    .replace(/^标题[:：]\s*/, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/["'“”‘’`]/g, "")
    .replace(/[。！？!?.,，、；;：:]+$/g, "")
    .trim();

  // Keep the first short sentence if the model returned explanations.
  title = title.split(/[。！？!?\n]/)[0]?.trim() ?? title;
  if (title.length > 20) title = title.slice(0, 20).trim();
  return title;
}

export async function maybeGenerateTitle(params: {
  sessionId: string;
  bridgeUrl: string;
}): Promise<string | null> {
  const session = await getSession(params.sessionId);
  if (!session || !isDefaultChatTitle(session.title)) return null;

  const messages = await listMessages(params.sessionId);
  const firstTurn = messages.slice(0, 4).map((m) => ({ role: m.role, content: m.content }));
  const hasUser = firstTurn.some((m) => m.role === "user" && m.content.trim());
  const hasAssistant = firstTurn.some((m) => m.role === "assistant" && m.content.trim());
  if (!hasUser || !hasAssistant) return null;

  try {
    const res = await fetch(`${params.bridgeUrl}/chat/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: firstTurn, credentialId: session.credential_id }),
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { title?: string };
    const title = sanitizeGeneratedTitle(body.title ?? "");
    if (!title) return null;

    const updated = await updateSessionTitleIfDefault(params.sessionId, title, [...DEFAULT_TITLES]);
    if (updated) {
      notify({ type: "chat_session_title", sessionId: params.sessionId, title });
      logger.info({ sessionId: params.sessionId, title }, "Generated chat session title");
      return title;
    }
    return null;
  } catch (err) {
    logger.debug({ err, sessionId: params.sessionId }, "Chat title generation skipped");
    return null;
  }
}
