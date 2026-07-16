/**
 * SandboxPlane Extension (Prepare)
 *
 * Two read-only tools per design v1.0 §5:
 *   list_sandbox_types() — current available sandbox types, minimal shape.
 *   get_sandbox_type(profile_id) — availability + capability flags for one type.
 *
 * Both call VulnAgent's own internal read-only SandboxPlane proxy
 * (packages/service/src/features/sandbox-plane/routes.ts), never SandboxPlane
 * directly. The proxy holds the real SandboxPlane base URL/token server-side;
 * this extension (running inside the worker container, reachable by pi/bash)
 * only ever sees SERVICE_URL + its own task id as bearer token — never a
 * SandboxPlane address, service token, SSH coordinate, or host detail.
 *
 * Environment (set by the scan worker container launch):
 *   SERVICE_URL - VulnAgent service base URL (e.g. http://service:28080)
 *   TASK_ID     - this task's id; doubles as the internal proxy bearer token
 *   PREPARE_SANDBOX_TYPES_FILE - optional; if set, the extension writes the
 *     full list_sandbox_types() result here on every call, so the platform's
 *     postflight validator (worker-assets/prepare-result-postflight.py) can
 *     check the model's chosen sandbox_type against the types it actually saw.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

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
  const snapshotFile = process.env.PREPARE_SANDBOX_TYPES_FILE;
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
  // (via either tool), regardless of call order, so platform postflight
  // membership validation (worker-assets/prepare-result-postflight.py)
  // reflects everything the agent could have legitimately chosen from.
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
}
