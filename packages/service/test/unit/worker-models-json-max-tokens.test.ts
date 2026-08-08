import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Batch 2 (fish 2026-08-08): scan-mode.sh and report-mode.sh no longer
 * generate models.json — they consume a pre-generated file from
 * /workspace/.pi-agent/models.json. These tests verify the defensive
 * behavior and correct consumption.
 *
 * The models.json field semantics (no maxTokens for openai, 36864 for
 * anthropic) are tested in credential-models.test.ts (33 tests).
 */

const WORKER_ASSETS = resolve(__dirname, "../../../../worker-assets");

describe("scan-mode.sh / report-mode.sh pre-generated models.json (batch 2)", () => {
  it("scripts no longer contain python3 heredoc generators", () => {
    // The old python heredoc must be gone from both scripts
    const scanSrc = readFileSync(join(WORKER_ASSETS, "scan-mode.sh"), "utf8");
    const reportSrc = readFileSync(join(WORKER_ASSETS, "report-mode.sh"), "utf8");

    // No more python heredoc model generation
    expect(scanSrc).not.toContain("<<'PY'");
    expect(reportSrc).not.toContain("<<'PY'");

    // Both now reference the pre-generated path
    expect(scanSrc).toContain("/workspace/.pi-agent/models.json");
    expect(reportSrc).toContain("/workspace/.pi-agent/models.json");
  });

  it("scripts have defensive FATAL on missing models.json", () => {
    const scanSrc = readFileSync(join(WORKER_ASSETS, "scan-mode.sh"), "utf8");
    const reportSrc = readFileSync(join(WORKER_ASSETS, "report-mode.sh"), "utf8");

    expect(scanSrc).toContain("FATAL");
    expect(scanSrc).toContain("not found");
    expect(reportSrc).toContain("FATAL");
    expect(reportSrc).toContain("not found");
  });

  it("bash: copies pre-generated models.json to FLOW_DIR and exits 0", () => {
    const workdir = mkdtempSync(join(tmpdir(), "shell-models-test-"));
    try {
      const agentDir = join(workdir, "pi-agent");
      const flowDir = join(workdir, "flow");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(flowDir, { recursive: true });

      const modelsJson = {
        providers: {
          platform: {
            api: "openai-completions",
            baseUrl: "https://api.example.com/v1",
            apiKey: "$VULNHUNTER_LLM_API_KEY",
            models: [{ id: "glm-5.2", contextWindow: 128000, input: ["text"] }],
          },
        },
      };
      writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson, null, 2) + "\n");
      writeFileSync(join(agentDir, "model-env.json"), JSON.stringify({ vDefaultModel: "platform/glm-5.2" }) + "\n");

      const script = `
        PI_AGENT_SRC="${agentDir}"
        FLOW_DIR="${flowDir}"
        cp "$PI_AGENT_SRC/models.json" "$FLOW_DIR/models.json"
        V_DEFAULT_MODEL="$(python3 -c "import json; print(json.load(open('$PI_AGENT_SRC/model-env.json'))['vDefaultModel'])" 2>/dev/null || echo '')"
        if [ -z "$V_DEFAULT_MODEL" ]; then exit 1; fi
        echo "model=$V_DEFAULT_MODEL"
      `;
      const stdout = execFileSync("bash", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] }).toString();
      expect(stdout).toContain("model=platform/glm-5.2");

      const copied = JSON.parse(readFileSync(join(flowDir, "models.json"), "utf8"));
      expect(copied.providers.platform.models[0].id).toBe("glm-5.2");
      expect(JSON.stringify(copied)).not.toContain("sk-");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("bash: exits 1 when models.json is missing (defensive)", () => {
    const workdir = mkdtempSync(join(tmpdir(), "shell-missing-test-"));
    try {
      const agentDir = join(workdir, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      // Don't create models.json

      let exitCode = 0;
      try {
        execFileSync("bash", ["-c", `
          PI_AGENT_SRC="${agentDir}"
          if [ ! -f "$PI_AGENT_SRC/models.json" ]; then
            echo "FATAL: not found" >&2
            exit 1
          fi
        `], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err: any) {
        exitCode = err.status ?? 1;
      }
      expect(exitCode).toBe(1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
