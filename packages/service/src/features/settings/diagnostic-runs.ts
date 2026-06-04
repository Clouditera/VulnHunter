import { randomUUID } from "node:crypto";
import type { ModelDiagnosticCheck } from "./model-diagnostics.js";
import { diagnoseModelRuntimeCredential, type RuntimeDiagnosticResult } from "./runtime-diagnostics.js";
import type { DecryptedLlmCredential } from "./storage.js";
import type { ServiceConfig } from "../../infra/config.js";

interface RunState extends RuntimeDiagnosticResult { id: string; status: "running" | "done" | "failed"; createdAt: number }
const runs = new Map<string, RunState>();

const initialLabels = ["配置检查", "基础连接", "启动运行时", "pi 初始化", "Agent 工具调用", "结果汇总"];
function pendingChecks(): ModelDiagnosticCheck[] { return initialLabels.map((label, i) => ({ id: `stage-${i}`, label, status: i === 0 ? "running" : "pending", message: i === 0 ? "正在测试..." : "等待中" })); }

export function startDiagnosticRun(cred: DecryptedLlmCredential, config: ServiceConfig, actor: { userId: string; tenantId: string; role: "admin" | "member" }): string {
  const id = randomUUID();
  runs.set(id, { id, status: "running", ok: false, summary: "模型可用性测试进行中。", checks: pendingChecks(), createdAt: Date.now() });
  void diagnoseModelRuntimeCredential(cred, config, actor, (partial) => {
    runs.set(id, { id, status: "running", ...partial, createdAt: runs.get(id)?.createdAt ?? Date.now() });
  }).then((result) => {
    runs.set(id, { id, status: "done", ...result, createdAt: runs.get(id)?.createdAt ?? Date.now() });
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    runs.set(id, { id, status: "failed", ok: false, summary: msg, checks: [{ id: "runtime_error", label: "结果汇总", status: "fail", message: msg }], createdAt: runs.get(id)?.createdAt ?? Date.now() });
  });
  return id;
}

export function getDiagnosticRun(id: string): RunState | null {
  const run = runs.get(id);
  if (!run) return null;
  for (const [rid, r] of runs) if (Date.now() - r.createdAt > 10 * 60_000) runs.delete(rid);
  return run;
}
