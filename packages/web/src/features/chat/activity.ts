import type { ChatActivityStatus } from "./types.js";

export interface ActivityDraft {
  status: ChatActivityStatus;
  label: string;
  detail?: string;
  ttlMs?: number;
}

type Phase = "start" | "success" | "error";

const TOOL_COPY: Record<string, { start: string; success: string; error: string }> = {
  "get-platform-overview": { start: "正在读取平台概览…", success: "已读取平台概览", error: "平台概览读取失败，已尝试继续处理。" },
  "list-tasks": { start: "正在查询扫描任务…", success: "已查询扫描任务", error: "任务查询失败，已尝试继续处理。" },
  "get-task-detail": { start: "正在查询任务详情…", success: "已查询任务详情", error: "任务详情查询失败，已尝试继续处理。" },
  "read-task-metadata": { start: "正在查询任务详情…", success: "已查询任务详情", error: "任务详情查询失败，已尝试继续处理。" },
  "get-task-events": { start: "正在读取任务事件…", success: "已读取任务事件", error: "任务事件读取失败，已尝试继续处理。" },
  "list-findings": { start: "正在读取漏洞信息…", success: "已读取漏洞列表", error: "漏洞信息读取失败，已尝试继续处理。" },
  "read-finding": { start: "正在读取漏洞详情…", success: "已读取漏洞详情", error: "漏洞详情读取失败，已尝试继续处理。" },
  "read-wiki": { start: "正在读取项目知识库…", success: "已读取项目知识库", error: "项目知识库读取失败，已尝试继续处理。" },
  "read-report": { start: "正在读取报告…", success: "已读取报告", error: "报告读取失败，已尝试继续处理。" },
  "get-poc-results": { start: "正在读取 POC 结果…", success: "已读取 POC 结果", error: "POC 结果读取失败，已尝试继续处理。" },
  "create-task": { start: "正在创建扫描任务…", success: "扫描任务已创建", error: "扫描任务创建失败，请检查输入后重试。" },
  "cancel-task": { start: "正在更新任务状态…", success: "任务操作已提交", error: "任务操作失败，请稍后重试。" },
  "control-task": { start: "正在更新任务状态…", success: "任务操作已提交", error: "任务操作失败，请稍后重试。" },
  "generate-report": { start: "正在启动报告生成…", success: "报告生成已启动", error: "报告生成启动失败，请稍后重试。" },
  "generate-poc": { start: "正在启动 POC 生成…", success: "POC 生成已启动", error: "POC 生成启动失败，请稍后重试。" },
  "present-artifact": { start: "正在生成文件…", success: "文件已生成", error: "文件生成失败，请稍后重试。" },
};

const UNKNOWN = { start: "正在调用平台工具…", success: "平台工具已完成", error: "工具调用失败，已尝试继续处理。" };

export function thinkingActivity(): ActivityDraft {
  return { status: "running", label: "正在思考…" };
}

export function respondingActivity(): ActivityDraft {
  return { status: "running", label: "正在整理回答…" };
}

export function stoppedActivity(): ActivityDraft {
  return { status: "neutral", label: "已停止生成", ttlMs: 2500 };
}

export function warningActivity(label = "工具调用失败，已尝试继续处理。") : ActivityDraft {
  return { status: "warning", label, ttlMs: 5000 };
}

export function mapToolActivity(tool: string | undefined, phase: Phase, payload?: unknown): ActivityDraft {
  const key = typeof tool === "string" ? tool : "";
  const copy = TOOL_COPY[key] ?? UNKNOWN;
  if (key === "present-artifact" && phase === "success") {
    const filename = safeFilenameFromPayload(payload);
    return { status: "success", label: filename ? `文件已生成：${filename}` : copy.success, ttlMs: 2500 };
  }
  if (phase === "start") return { status: "running", label: copy.start };
  if (phase === "success") return { status: "success", label: copy.success, ttlMs: 2500 };
  return { status: "warning", label: copy.error, ttlMs: 5000 };
}

export function safeFilenameFromPayload(payload: unknown): string | null {
  const obj = parsePayload(payload);
  const value = pickString(obj, ["filename", "original_name", "title"]);
  if (!value) return null;
  return truncateUserLabel(value.split(/[\\/]/).pop() ?? value, 48);
}

export function truncateUserLabel(value: string, max = 32): string {
  const clean = value.replace(/[\r\n\t]/g, " ").replace(/[<>]/g, "").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try { return JSON.parse(payload); } catch { return null; }
  }
  return payload;
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }
  if (obj.artifact && typeof obj.artifact === "object") return pickString(obj.artifact, keys);
  return null;
}
