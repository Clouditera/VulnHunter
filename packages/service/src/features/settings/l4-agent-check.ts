/**
 * L4 deep verification: pi CLI headless agent circuit check.
 *
 * Runs `pi -p --mode json` as a subprocess with the user's credential to verify
 * a real agent loop closes: model → tool call → tool result → assistant completes.
 *
 * Design: subprocess isolation (agent crash doesn't affect service), same pi
 * binary as worker, JSON event stream for programmatic assertion.
 *
 * models.json is placed at `<workDir>/agent/models.json` and pi is pointed
 * there via `PI_CODING_AGENT_DIR` env (pi CLI reads models.json by convention,
 * not via a CLI flag).
 *
 * Spec: architecture/llm-layer-unify-pi-version-native-credential-test-v1.0.md §3 L4
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_VERSION } from "@vulnhunter/shared";
import { logger } from "../../infra/logger.js";
import { formatRawError } from "./pi-diagnostics.js";

export interface L4CheckInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  protoType: string;
  thinkingEffort?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export type L4CheckResult = {
  status: "pass" | "fail";
  durationMs: number;
  detail: string;
  /** Raw JSON events from pi CLI (truncated for diagnostics). */
  events?: unknown[];
};

/** fish 2026-08-06: L1-L4 unified 120s timeout. */
const L4_TIMEOUT_MS = 120_000;

/** Env var that carries the credential into the pi subprocess (never on argv). */
const L4_API_KEY_ENV = "VULNHUNTER_L4_API_KEY";

/**
 * Build a minimal models.json for pi CLI convention path
 * (`<agentDir>/models.json`). Declares a "platform" provider with the user's
 * real baseUrl. The API key is an env template (`$VULNHUNTER_L4_API_KEY`) —
 * pi CLI's resolve-config-value interpolates $ENV_VAR references in
 * models.json at runtime, and we feed that env var to the child process.
 * This keeps the key out of the process argument list (ps-visible).
 */
async function writeModelsJson(
  agentDir: string,
  input: L4CheckInput,
): Promise<void> {
  const apiType =
    input.protoType === "anthropic" || input.protoType === "anthropic-messages"
      ? "anthropic-messages"
      : input.protoType === "openai-responses"
        ? "openai-responses"
        : "openai-completions";

  // Match prepare-worker's proven format. apiKey is an env template resolved
  // by pi from the child env (L4_API_KEY_ENV) — never a literal.
  // fish 2026-08-05: completions endpoints default supportsDeveloperRole=false
  // — the L4 test path must match the real-task generation shape.
  const modelEntry: Record<string, unknown> = { id: input.modelId };
  if (apiType === "openai-completions") modelEntry.compat = { supportsDeveloperRole: false };
  const models = {
    providers: {
      platform: {
        api: apiType,
        baseUrl: input.baseUrl.replace(/\/$/, ""),
        apiKey: `$${L4_API_KEY_ENV}`,
        models: [modelEntry],
      },
    },
  };

  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify(models, null, 2) + "\n", "utf-8");
}

/**
 * Run L4 check: spawn pi CLI headless, parse JSON events, assert agent settled
 * with non-error assistant output.
 */
export async function runL4Check(input: L4CheckInput): Promise<L4CheckResult> {
  const start = Date.now();
  let workDir: string | null = null;

  try {
    workDir = await mkdtemp(join(tmpdir(), "pi-l4-"));
    const agentDir = join(workDir, "agent");
    await writeModelsJson(agentDir, input);

    const args = [
      "-p",
      "--mode", "json",
      "--no-session",
      "--provider", "platform",
      "--model", input.modelId,
      "Use the bash tool to run: ls. Then stop and reply with the word: ok",
    ];

    const events: unknown[] = [];
    let stderr = "";
    /** True when the hard deadline fired — the child (or a grandchild holding
     *  the stdio pipe) never closed. QA R1 (2026-08-06): SIGTERM alone left
     *  the promise pending forever because `close` waits for ALL stdio to
     *  EOF; a killed pi with a live bash grandchild never EOFs. */
    let timedOut = false;

    await new Promise<void>((resolve) => {
      const child = spawn("pi", args, {
        cwd: workDir!,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          // Credential rides the env channel (invisible to ps), resolved by
          // pi from the models.json $VULNHUNTER_L4_API_KEY template.
          [L4_API_KEY_ENV]: input.apiKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let settled = false;
      const forceSettle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      // Hard deadline (fish 2026-08-06): when it fires, the layer FAILS.
      // SIGTERM is best-effort; SIGKILL after a 2s grace for orphan cleanup.
      // forceSettle() guarantees the promise ALWAYS resolves — a hung
      // subprocess can no longer leave the credential test spinning.
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2_000);
        forceSettle();
      }, L4_TIMEOUT_MS);

      input.signal?.addEventListener("abort", () => {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
        forceSettle();
      }, { once: true });

      let stdoutBuf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("Warning:")) continue;
          try {
            events.push(JSON.parse(trimmed));
          } catch {
            // Non-JSON line — skip
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("close", () => {
        if (!settled) {
          // Parse any remaining stdout
          if (stdoutBuf.trim()) {
            try { events.push(JSON.parse(stdoutBuf.trim())); } catch { /* skip */ }
          }
          forceSettle();
        }
      });

      // Early exit on any non-zero or null exit code (ENOENT, bad args, etc.)
      child.on("exit", (code) => {
        if (!settled && code !== 0) {
          if (stdoutBuf.trim()) {
            try { events.push(JSON.parse(stdoutBuf.trim())); } catch { /* skip */ }
          }
          forceSettle();
        }
      });

      child.on("error", () => {
        if (!settled) forceSettle();
      });
    });

    const durationMs = Date.now() - start;

    // Hard timeout verdict (fish 2026-08-06): the child never closed within
    // the 120s budget — report the raw timeout, not a guessed classification.
    if (timedOut) {
      return {
        status: "fail" as const,
        durationMs,
        detail: formatRawError(`timeout after ${L4_TIMEOUT_MS / 1000}s`),
      };
    }

    // Assert (fish 2026-08-05): the agent must actually close a real tool
    // loop — bash tool call observed, tool result present, agent settled.
    // Schema (QA-verified on pi 0.83 --mode json): the RPC JSONL stream has
    // NO tool_execution_* events; tool traces ride message_end/turn_end:
    //   - message_end.message.content[]: ToolCall block { type:"toolCall",
    //     name, arguments } (pi-ai types.d.ts:253)
    //   - turn_end.toolResults[]: ToolResultMessage { toolName, content }
    //     (pi-agent-core types.d.ts:100)
    const agentSettled = events.some(
      (e) => (e as { type?: string }).type === "agent_settled",
    );

    const bashToolCalls = events.filter((e) => {
      const ev = e as { type?: string; message?: { content?: Array<{ type?: string; name?: string }> } };
      return ev.type === "message_end" && Array.isArray(ev.message?.content)
        && ev.message!.content!.some((b) => b.type === "toolCall" && b.name === "bash");
    });
    const bashToolResults = events.filter((e) => {
      const ev = e as { type?: string; toolResults?: Array<{ toolName?: string; content?: unknown[] }> };
      return ev.type === "turn_end" && Array.isArray(ev.toolResults)
        && ev.toolResults!.some((r) => r.toolName === "bash" && Array.isArray(r.content) && r.content.length > 0);
    });
    const toolCallObserved = bashToolCalls.length > 0 && bashToolResults.length > 0;

    const assistantMessages = events.filter(
      (e) =>
        (e as { type?: string }).type === "message_end" &&
        (e as { message?: { role?: string } }).message?.role === "assistant",
    );

    const hasError = assistantMessages.some(
      (e) => (e as { message?: { stopReason?: string } }).message?.stopReason === "error",
    );

    const hasContent = assistantMessages.some((e) => {
      const content = (e as { message?: { content?: unknown[] } }).message?.content;
      return Array.isArray(content) && content.length > 0;
    });

    if (!agentSettled && events.length === 0) {
      return {
        status: "fail",
        durationMs,
        detail: stderr.trim().slice(0, 300) || "pi CLI produced no output",
      };
    }

    if (!agentSettled) {
      return {
        status: "fail",
        durationMs,
        detail: "pi CLI did not reach agent_settled state",
        events: events.slice(0, 5),
      };
    }

    if (hasError) {
      const errMsg = assistantMessages.find(
        (e) => (e as { message?: { errorMessage?: string } }).message?.errorMessage,
      );
      const detail =
        (errMsg as { message?: { errorMessage?: string } })?.message?.errorMessage ??
        "upstream error";
      return {
        status: "fail",
        durationMs,
        detail: detail.slice(0, 300),
        events: events.slice(0, 5),
      };
    }

    if (!hasContent) {
      return {
        status: "fail",
        durationMs,
        detail: "Agent completed but produced no output content",
        events: events.slice(0, 5),
      };
    }

    if (!toolCallObserved) {
      return {
        status: "fail",
        durationMs,
        detail: `Agent completed without a clean bash tool call (bash_calls=${bashToolCalls.length}, bash_results=${bashToolResults.length}) — the model may not honor tool instructions or the endpoint rejects tool requests`,
        events: events.slice(0, 5),
      };
    }

    return {
      status: "pass",
      durationMs,
      detail: `Agent circuit OK (pi ${PI_VERSION}, bash tool call + result verified, ${assistantMessages.length} assistant message(s))`,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, durationMs }, "L4 check failed");
    return {
      status: "fail",
      durationMs,
      detail: msg.slice(0, 300),
    };
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
