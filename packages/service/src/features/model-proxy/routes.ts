/**
 * Credential-free internal model proxy (P0 design §1/§2/§3).
 *
 * The prepare worker's pi/youngflow makes its model calls against
 * `${SERVICE_URL}/internal/model-proxy/<provider-native-path>` with
 * `Authorization: Bearer <task-id>`. This route:
 *   1. authenticates the task-id bearer (shared taskBearerAuth, state=preparing);
 *   2. resolves that task's real LLM credential inside the service process
 *      (decrypted only in memory, serialized only into the outbound auth header);
 *   3. forwards the request path + body verbatim to the real provider baseUrl,
 *      replacing only the auth header with the real key;
 *   4. streams the provider response (including SSE) back verbatim.
 *
 * The worker / pi / bash never sees the real API key — only SERVICE_URL and
 * its own (non-secret) task id, exactly like the P2 sandbox-plane proxy.
 *
 * The proxy is protocol-agnostic: it does not parse OpenAI/Anthropic bodies,
 * so any provider-native path the model SDK emits is forwarded as-is.
 */
import { Hono } from "hono";
import { modelProxyTaskBearerAuth, getInternalTask } from "../internal/task-bearer-auth.js";
import { getCredentialById, getDefaultCredential, type DecryptedLlmCredential } from "../settings/storage.js";
import { logger } from "../../infra/logger.js";

export const modelProxyInternalRouter = new Hono();

modelProxyInternalRouter.use("*", modelProxyTaskBearerAuth);

/** Hop-by-hop headers that must not be forwarded verbatim. */
const STRIP_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
]);

/** Resolve the task's real credential (task-specific, else default). */
async function resolveTaskCredential(credentialId: string | null): Promise<DecryptedLlmCredential | null> {
  return credentialId ? await getCredentialById(credentialId) : await getDefaultCredential();
}

/** Provider auth header name/value for the real key. */
function providerAuth(protoType: string, apiKey: string): { name: string; value: string } {
  // Anthropic Messages API authenticates with x-api-key; the OpenAI family
  // (completions/responses) uses a Bearer token.
  return protoType.startsWith("anthropic")
    ? { name: "x-api-key", value: apiKey }
    : { name: "authorization", value: `Bearer ${apiKey}` };
}

modelProxyInternalRouter.all("/*", async (c) => {
  const task = getInternalTask(c);
  if (!task) return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);

  const cred = await resolveTaskCredential(task.credential_id ?? null).catch((err) => {
    logger.error({ err, taskId: task.id }, "Model proxy credential resolution failed");
    return null;
  });
  if (!cred || !cred.api_key || !cred.base_url) {
    // Fixed error code, no credential detail leaked.
    return c.json({ error: { code: "ERR_MODEL_CREDENTIAL_UNAVAILABLE" } }, 502);
  }

  const baseUrl = cred.base_url.replace(/\/+$/, "");
  // c.req.path is /internal/model-proxy/<rest>; strip the mount prefix.
  const rest = c.req.path.replace(/^\/internal\/model-proxy/, "");
  const targetUrl = `${baseUrl}${rest}${new URL(c.req.url).search}`;

  const auth = providerAuth(cred.proto_type, cred.api_key);
  const headers = new Headers();
  for (const [name, value] of c.req.raw.headers.entries()) {
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  headers.set(auth.name, auth.value);

  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;

  const started = Date.now();
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, { method, headers, body, redirect: "manual" });
  } catch (err) {
    logger.warn({ err, taskId: task.id, path: rest }, "Model proxy upstream request failed");
    return c.json({ error: { code: "ERR_MODEL_UPSTREAM_UNREACHABLE" } }, 502);
  }
  logger.info({ taskId: task.id, path: rest, status: upstream.status, ms: Date.now() - started }, "Model proxy forwarded");

  // Stream the response (including SSE) back verbatim, minus hop-by-hop headers.
  const respHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "connection" || lower === "transfer-encoding" || lower === "content-length" || lower === "content-encoding") return;
    respHeaders.set(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
});
