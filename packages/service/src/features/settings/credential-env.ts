/**
 * Shared credential → worker env var serialization.
 * Used by scan-worker (scheduler), chat-worker (ChatSession), and report-worker.
 *
 * Batch 2 (fish 2026-08-08): now also pre-generates models.json via the
 * unified buildModelsJson module, writing it to the host workdir for the
 * worker container to consume. Shell-side python heredoc generators retired.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecryptedLlmCredential } from "./storage.js";
import { buildModelsJson, type DecryptedCredentialLike } from "./credential-models.js";
import { logger } from "../../infra/logger.js";

/**
 * Worker env vars for credential injection.
 * The API key is carried as VULNHUNTER_LLM_API_KEY (matching the
 * $VULNHUNTER_LLM_API_KEY template in models.json).
 *
 * Legacy vars (LLM_*) are kept for backward-compat during the transition
 * (batch 2/3/4), but workers now consume models.json from the pre-generated
 * file, not from these env vars.
 */
export function credentialToWorkerEnv(cred: DecryptedLlmCredential): Record<string, string> {
  return {
    // Unified module env key (models.json references $VULNHUNTER_LLM_API_KEY)
    VULNHUNTER_LLM_API_KEY: cred.api_key,
    // Legacy vars retained for any remaining consumers during transition
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

/**
 * Build the V_DEFAULT_MODEL string for youngflow .env.
 * Format: "platform/model_id" or "platform/model_id:effort" (when thinking is active).
 */
function buildDefaultModelString(cred: DecryptedCredentialLike): string {
  const isThinking =
    !!cred.thinking_effort &&
    cred.thinking_effort !== "off" &&
    cred.thinking_effort !== "none" &&
    cred.thinking_effort !== "";
  const effort = isThinking ? cred.thinking_effort : "";
  return `platform/${cred.model_id}${effort ? `:${effort}` : ""}`;
}

/** Directory inside the worker container's mounted /workspace */
const PI_AGENT_DIR = ".pi-agent";

/**
 * Pre-generate models.json and V_DEFAULT_MODEL for a worker.
 * Writes to `hostWorkDir/.pi-agent/`:
 *   - models.json     (pi-native config, $ENV_VAR key template)
 *   - model-env.json  ({ vDefaultModel: string })
 *
 * The scan-mode.sh / report-mode.sh entrypoint copies models.json from
 * /workspace/.pi-agent/ to $FLOW_DIR/ and writes .env from model-env.json.
 */
export async function writeWorkerModelsJson(
  cred: DecryptedLlmCredential,
  hostWorkDir: string,
): Promise<void> {
  const credLike: DecryptedCredentialLike = {
    proto_type: cred.proto_type,
    base_url: cred.base_url,
    model_id: cred.model_id,
    thinking_effort: cred.thinking_effort,
    context_window_tokens: cred.context_window_tokens,
    api_key: cred.api_key,
    advanced_config: (cred as any).advanced_config ?? null,
  };

  const result = await buildModelsJson(credLike);
  const agentDir = join(hostWorkDir, PI_AGENT_DIR);
  await mkdir(agentDir, { recursive: true });

  // Write models.json
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify(result.modelsJson, null, 2) + "\n",
    "utf-8",
  );

  // Write model-env.json for the shell script to consume
  const vDefaultModel = buildDefaultModelString(credLike);
  await writeFile(
    join(agentDir, "model-env.json"),
    JSON.stringify({ vDefaultModel }, null, 2) + "\n",
    "utf-8",
  );

  logger.debug({ vDefaultModel }, "Pre-generated worker models.json + model-env");
}
