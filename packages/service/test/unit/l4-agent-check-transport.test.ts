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
/** When true the mock child emits NO tool events (assertion must fail). */
let noToolCall = false;
/** When true the mock child emits NOTHING and never closes (hard-timeout test). */
let hangMode = false;
/** When true the mock child replays the REAL captured pi event stream. */
let fixtureMode = false;

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
      // fish 2026-08-05: L4 asserts a REAL bash tool loop. pi 0.83 --mode
      // json carries tool traces on message_end.content (ToolCall block) and
      // turn_end.toolResults (ToolResultMessage) — NOT tool_execution_* events
      // (QA-verified on the real stream). Mock closes a bash loop accordingly.
      if (hangMode) {
        return; // child never emits, never closes — only the hard deadline can settle
      }
      if (fixtureMode) {
        for (const line of REAL_FIXTURE_LINES) {
          child.stdout.emit("data", Buffer.from(line + "\n"));
        }
        child.emit("close", 0);
        return;
      }
      if (noToolCall) {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        }) + "\n"));
        child.emit("close", 0);
        return;
      }
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", stopReason: "tool_use",
          content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
        },
      }) + "\n"));
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "turn_end",
        message: { role: "assistant" },
        toolResults: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out.txt\n" }] }],
      }) + "\n"));
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

import { readFileSync } from "node:fs";
const REAL_FIXTURE_LINES = readFileSync(
  new URL("../fixtures/l4-pi-events-real.jsonl", import.meta.url),
  "utf-8",
).split("\n").filter((l) => l.trim());

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
    noToolCall = false;
    hangMode = false;
    fixtureMode = false;
  });

  it("passes against the REAL captured pi event stream (qa-nery 23130 fixture)", async () => {
    fixtureMode = true;
    const result = await runL4Check(input());
    expect(result.status).toBe("pass");
  });

  it("fails when the agent never closes a bash tool call (fish 2026-08-05 assertion)", async () => {
    noToolCall = true;
    const result = await runL4Check(input());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("bash tool call");
  });

  it("hard timeout at 120s: fails with the raw timeout even when the child never closes (QA R1 hang, fish 2026-08-06)", async () => {
    // Fake timers FIRST: runL4Check's internal deadline setTimeout must be
    // fake, or advanceTimersByTimeAsync can't fire it.
    vi.useFakeTimers();
    try {
      hangMode = true;
      const promise = runL4Check(input());
      // mkdtemp/writeModelsJson are real async fs — yield to the event loop
      // with small fake-time advances until the pi child is spawned and its
      // fake deadline timer armed.
      for (let i = 0; i < 200 && spawnCalls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(5);
      }
      expect(spawnCalls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await promise;
      expect(result.status).toBe("fail");
      expect(result.detail).toBe("timeout after 120s");
    } finally {
      vi.useRealTimers();
    }
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
