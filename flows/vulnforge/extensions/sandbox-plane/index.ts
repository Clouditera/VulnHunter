/**
 * SandboxPlane Extension (vulnforge onboard gate)
 *
 * Two read-only tools per design v1.0 §5:
 *   list_sandbox_types() — current available sandbox types, minimal shape.
 *   get_sandbox_type(profile_id) — availability + capability flags for one type.
 *
 * Both call VulnHunter's own internal read-only SandboxPlane proxy
 * (packages/service/src/features/sandbox-plane/routes.ts), never SandboxPlane
 * directly. The proxy holds the real SandboxPlane base URL/token server-side;
 * this extension (running inside the worker container, reachable by pi/bash)
 * only ever sees SERVICE_URL + its own task id as bearer token — never a
 * SandboxPlane address, service token, SSH coordinate, or host detail.
 *
 * Environment (set by the scan worker container launch):
 *   SERVICE_URL - VulnHunter service base URL (e.g. http://service:28080)
 *   TASK_ID     - this task's id; doubles as the internal proxy bearer token
 *   SANDBOX_TYPES_SNAPSHOT_FILE - optional; if set, the extension writes the
 *     full list_sandbox_types() result here on every call (audit evidence of
 *     what the agent could legitimately choose from; the callback endpoint
 *     validates the choice server-side against the live plane).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface ProjectedSandboxType {
  profile_id: string;
  available: boolean;
  docker: boolean;
  kvm: boolean;
  qemu: boolean;
}

export default function (pi: ExtensionAPI) {
  const serviceUrl = process.env.SERVICE_URL;
  const taskId = process.env.TASK_ID;
  const snapshotFile = process.env.SANDBOX_TYPES_SNAPSHOT_FILE;
  if (!serviceUrl || !taskId) return;

  const base = serviceUrl.replace(/\/+$/, "");

  async function proxyGet(path: string): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${taskId}` },
    });
    if (!res.ok) throw new Error(`sandbox-plane proxy returned HTTP ${res.status}`);
    return res.json();
  }

  // Snapshot accumulates every type the agent has actually seen this run
  // (via either tool), regardless of call order — audit evidence of what the
  // agent could legitimately choose from (the service validates the submitted
  // choice live at gate time).
  const seen = new Map<string, ProjectedSandboxType>();

  function recordSnapshot(types: ProjectedSandboxType[]): void {
    if (!snapshotFile) return;
    for (const t of types) seen.set(t.profile_id, t);
    try {
      writeFileSync(snapshotFile, JSON.stringify([...seen.values()]));
    } catch {
      // Snapshot is a defense-in-depth aid for platform postflight validation;
      // a write failure must not block the agent's own tool result.
    }
  }

  pi.registerTool(defineTool({
    name: "list_sandbox_types",
    label: "List Sandbox Types",
    description:
      "列出当前可用的沙箱类型及其最小能力信息（profile_id + available + docker/kvm/qemu 能力标志）。不返回沙箱服务地址、凭证、SSH 坐标或宿主机信息。",
    promptSnippet:
      "list_sandbox_types() — 仅在动态验证开启且需要判断沙箱类型时调用，列出当前可用沙箱类型及 docker/kvm/qemu 能力。",
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      let types: ProjectedSandboxType[];
      try {
        const body = (await proxyGet("/internal/sandbox-plane/types")) as { types?: ProjectedSandboxType[] };
        types = Array.isArray(body?.types) ? body.types : [];
      } catch {
        types = [];
      }
      recordSnapshot(types);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(types) }],
        details: { count: types.length },
      };
    },
  }));

  async function proxyPost(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${taskId}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON error body */ }
    return { status: res.status, json };
  }

  pi.registerTool(defineTool({
    name: "get_sandbox_type",
    label: "Get Sandbox Type",
    description:
      "查询单个沙箱类型是否可用及其 docker/kvm/qemu 能力标志。不返回沙箱服务地址、凭证、SSH 坐标或宿主机信息。",
    promptSnippet:
      "get_sandbox_type(profile_id) — 查询某一沙箱类型当前是否可用及能力标志。",
    parameters: Type.Object({
      profile_id: Type.String({ description: "要查询的沙箱类型 profile_id。" }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      let type: ProjectedSandboxType | null;
      try {
        const body = (await proxyGet(`/internal/sandbox-plane/types/${encodeURIComponent(params.profile_id)}`)) as {
          type?: ProjectedSandboxType | null;
        };
        type = body?.type ?? null;
      } catch {
        type = null;
      }
      if (type) recordSnapshot([type]);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(type) }],
        details: { found: type !== null },
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "apply_sandbox",
    label: "Apply Sandbox",
    description:
      "申请分配一个指定类型的沙箱（onboard 第 5 步动态任务专用）。成功时沙箱配置写入工作区且沙箱即刻可用；失败时返回具体原因（quota=配额不足 / capacity=服务容量不足 / plane_unavailable=服务不可用 / type_unavailable=类型不存在或不可用）。失败不重试：把返回的 message 原样写进 gate.yaml 的 detail 并将 next 置为 end。",
    promptSnippet:
      "apply_sandbox(profile_id) — 动态任务在第 5 步选定沙箱类型后申请分配；仅调用一次，失败即写 gate.yaml{next:end}。",
    parameters: Type.Object({
      profile_id: Type.String({ description: "要申请的沙箱类型 profile_id（必须先经 list/get 确认可用）。" }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      let result: { status: number; json: any };
      try {
        result = await proxyPost("/internal/sandbox-plane/apply", { profile_id: params.profile_id });
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "plane_unavailable", message: `沙箱服务不可用（${String(err)}）` }) }],
          details: { ok: false },
        };
      }
      if (result.status === 200 && result.json?.ok) {
        // Persist the alias-only sandbox config into the workspace root; the
        // engine passes its path to dynamic stages via sandbox_cfg.
        const outDir = process.env.YOUNGFLOW_OUTPUT_DIR;
        if (outDir && typeof result.json.sandbox_config === "string") {
          try {
            writeFileSync(join(outDir, ".sandbox_config"), result.json.sandbox_config, { mode: 0o644 });
          } catch {
            // write failure must not lose the ok signal; the platform
            // continue/resume path re-renders the file from the mapping.
          }
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, profile_id: params.profile_id }) }],
          details: { ok: true },
        };
      }
      const payload = result.json ?? {};
      const body = {
        ok: false,
        reason: typeof payload.reason === "string" ? payload.reason : `http_${result.status}`,
        message: typeof payload.message === "string" ? payload.message : `沙箱申请失败（HTTP ${result.status}）`,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
        details: { ok: false },
      };
    },
  }));
}
