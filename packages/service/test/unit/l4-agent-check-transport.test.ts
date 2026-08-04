import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies the L4 credential transport: the API key must reach the pi
 * subprocess ONLY via the env channel (ps-invisible), never via argv —
 * and models.json must reference it as a $ENV template (pi 0.83
 * resolve-config-value interpolates it at runtime).
 */

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string | undefined> };
}

const spawnCalls: SpawnCall[] = [];
const modelsJsonSnapshots: string[] = [];

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: SpawnCall["options"]) => {
    spawnCalls.push({ command, args, options });
    // Snapshot models.json synchronously at spawn time (before runL4Check's
    // finally-cleanup removes the workDir).
    const agentDir = options.env?.PI_CODING_AGENT_DIR;
    if (agentDir) {
      try {
        modelsJsonSnapshots.push(readFileSync(join(agentDir, "models.json"), "utf-8"));
      } catch {
        modelsJsonSnapshots.push("");
      }
    }
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  },
}));

const { runL4Check } = await import("../../src/features/settings/l4-agent-check.js");

const SECRET = "sk-unit-test-secret-DoNotLeak";

function input(protoType = "openai-completions") {
  return {
    baseUrl: "https://api.example.com/v1",
    apiKey: SECRET,
    modelId: "test-model",
    protoType,
  };
}

describe("L4 credential transport (no argv leak)", () => {
  afterEach(() => {
    spawnCalls.length = 0;
    modelsJsonSnapshots.length = 0;
  });

  it("passes and never places the API key on the command line", async () => {
    const result = await runL4Check(input());
    expect(result.status).toBe("pass");

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.command).toBe("pi");
    expect(call.args.join(" ")).not.toContain(SECRET);
    expect(call.args).not.toContain("--api-key");
  });

  it("feeds the key via VULNHUNTER_L4_API_KEY env (ps-invisible channel)", async () => {
    await runL4Check(input("anthropic"));
    const call = spawnCalls[0];
    expect(call.options.env?.VULNHUNTER_L4_API_KEY).toBe(SECRET);
    expect(call.options.env?.PI_CODING_AGENT_DIR).toBeTruthy();
  });

  it("models.json holds only the $VULNHUNTER_L4_API_KEY template, never the literal key", async () => {
    await runL4Check(input());
    expect(modelsJsonSnapshots).toHaveLength(1);
    const content = modelsJsonSnapshots[0];
    expect(content).toContain("$VULNHUNTER_L4_API_KEY");
    expect(content).not.toContain(SECRET);
    // sanity: provider shape intact
    const parsed = JSON.parse(content) as { providers: Record<string, { baseUrl: string; apiKey: string }> };
    expect(parsed.providers.platform.baseUrl).toBe("https://api.example.com/v1");
    expect(parsed.providers.platform.apiKey).toBe("$VULNHUNTER_L4_API_KEY");
  });
});
