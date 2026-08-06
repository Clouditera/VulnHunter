import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKER_ASSETS = resolve(__dirname, "../../../../worker-assets");

/**
 * Real-scan models.json generation (task-64d20cec, fish 2026-08-06): the
 * worker heredoc must NOT carry a self-imposed maxTokens for OpenAI-compatible
 * APIs (kimi mid-tier thinking budget 400 on REAL scans) and MUST keep
 * 36864 for anthropic (/messages API-required). Executes the exact embedded
 * python heredoc from worker-assets/scan-mode.sh + report-mode.sh.
 */
function extractPython(scriptPath: string, marker: string): string {
  const src = readFileSync(scriptPath, "utf8");
  const start = src.indexOf(`<<'${marker}'`);
  const pyStart = src.indexOf("\n", start) + 1;
  const end = src.indexOf(`\n${marker}\n`, pyStart);
  if (start < 0 || end < 0) throw new Error(`heredoc ${marker} not found in ${scriptPath}`);
  return src.slice(pyStart, end);
}

function runGenerator(scriptPath: string, marker: string, env: Record<string, string>) {
  const py = extractPython(scriptPath, marker);
  const dir = mkdtempSync(join(tmpdir(), "models-json-test-"));
  try {
    const outPath = join(dir, "models.json");
    execFileSync("python3", ["-c", py, outPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(readFileSync(outPath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COMMON = {
  LLM_MODEL_NAME: "glm-5.2",
  LLM_DIRECT_BASE_URL: "https://gateway.example/v1",
  LLM_CONTEXT_WINDOW_TOKENS: "128000",
};

describe("scan-mode.sh models.json (64d20cec)", () => {
  const scan = join(WORKER_ASSETS, "scan-mode.sh");
  const scanMarker = "PY";

  it("openai-completions entry carries NO maxTokens (gateway default)", () => {
    const models = runGenerator(scan, scanMarker, { ...COMMON, MODEL_PROTO_TYPE: "openai-completions", MODEL_EFFORT: "off" });
    const entry = models.providers.platform.models[0];
    expect(entry.maxTokens).toBeUndefined();
    expect(Object.keys(entry)).not.toContain("maxTokens");
  });

  it("openai-completions with medium thinking still carries NO maxTokens (kimi regression)", () => {
    const models = runGenerator(scan, scanMarker, { ...COMMON, MODEL_PROTO_TYPE: "openai-completions", MODEL_EFFORT: "medium" });
    const entry = models.providers.platform.models[0];
    expect(entry.maxTokens).toBeUndefined();
    expect(entry.reasoning).toBe(true);
  });

  it("anthropic-messages keeps maxTokens 36864 (API-required, budget+margin)", () => {
    const models = runGenerator(scan, scanMarker, { ...COMMON, MODEL_PROTO_TYPE: "anthropic", MODEL_EFFORT: "medium" });
    const entry = models.providers.platform.models[0];
    expect(entry.maxTokens).toBe(36864);
  });
});

describe("report-mode.sh models.json (64d20cec)", () => {
  const report = join(WORKER_ASSETS, "report-mode.sh");
  const reportMarker = "PY";

  it("openai-completions entry carries NO maxTokens", () => {
    const models = runGenerator(report, reportMarker, { ...COMMON, MODEL_PROTO_TYPE: "openai-completions", MODEL_EFFORT: "off" });
    const entry = models.providers.platform.models[0];
    expect(entry.maxTokens).toBeUndefined();
  });

  it("anthropic-messages keeps maxTokens 36864", () => {
    const models = runGenerator(report, reportMarker, { ...COMMON, MODEL_PROTO_TYPE: "anthropic-messages", MODEL_EFFORT: "high" });
    const entry = models.providers.platform.models[0];
    expect(entry.maxTokens).toBe(36864);
  });
});
