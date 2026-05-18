/**
 * Shared credential → worker env var serialization.
 * Used by both scan-worker (scheduler) and chat-worker (ChatSession).
 */

import type { DecryptedLlmCredential } from "./storage.js";

export function credentialToWorkerEnv(cred: DecryptedLlmCredential): Record<string, string> {
  return {
    MODEL_PROTO_TYPE: cred.proto_type,
    LLM_MODEL_NAME: cred.model_id,
    LLM_API_KEY: cred.api_key,
    LLM_BASE_URL: normalizeBaseUrl(cred.base_url ?? ""),
    MODEL_EFFORT: cred.thinking_effort ?? "off",
    LLM_CONTEXT_WINDOW_TOKENS: String(cred.context_window_tokens ?? 128000),
  };
}

function normalizeBaseUrl(url: string): string {
  if (!url) return "";
  return url.replace(/\/+$/, "");
}
