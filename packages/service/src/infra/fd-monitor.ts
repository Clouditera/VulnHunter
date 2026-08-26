/**
 * HALL-18 A3: fd 自监控。
 *
 * 背景（2026-08-24 生产事故）：vulnhunter-service 增量输出同步 fd 泄漏
 * （~6.5k fd/小时），逼近 nofile 上限触发 EMFILE。ulimit 调大只是缓解；
 * 这里提供运行时可观测性：定期读 /proc/self/fd 数量并按 nofile soft
 * limit 阈值分级记录日志，为后续告警（metrics/notify）留结构化钩子。
 *
 * 设计：
 *  - countOpenFds(): 扫 /proc/self/fd 目录项数（O(1) readdir 计数）。
 *  - readNofileSoftLimit(): 解析 /proc/self/limits 的 "Max open files" 行
 *    soft 值；非 Linux / 解析失败 → 0（不分级，仅计数）。
 *  - evaluateFdUsage(): 纯函数分级 — ratio < 0.70 info、< 0.85 warn、
 *    ≥ 0.85 error；soft limit 为 0 时不分级（level=info）。
 *  - startFdMonitor()/stopFdMonitor(): 5 分钟周期（默认）记录一次；
 *    幂等 — 重复 start 复用同一 timer，不叠加。
 */

import { readFileSync, readdirSync } from "node:fs";
import { logger } from "./logger.js";

/** 默认采样周期：5 分钟（issue HALL-18 方案 A3）。 */
export const FD_MONITOR_INTERVAL_MS = 5 * 60_000;

/** soft limit 70% → warn；85% → error。 */
const WARN_RATIO = 0.7;
const ERROR_RATIO = 0.85;

export function countOpenFds(): number {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return -1; // /proc 不可用（非 Linux）— 调用方按未知处理
  }
}

/** 解析 /proc/self/limits 的 "Max open files" soft 值；失败 → 0。 */
export function readNofileSoftLimit(): number {
  try {
    const limits = readFileSync("/proc/self/limits", "utf-8");
    for (const line of limits.split("\n")) {
      if (!line.startsWith("Max open files")) continue;
      // "Max open files   1048576   1048576   files"
      const soft = Number(line.trim().split(/\s+/)[1]);
      return Number.isFinite(soft) ? soft : 0;
    }
  } catch {
    // fallthrough
  }
  return 0;
}

export interface FdUsage {
  fds: number;
  softLimit: number;
  ratio: number;
  level: "info" | "warn" | "error";
}

/** 纯函数：按 nofile soft limit 对当前 fd 数分级（告警钩子友好）。 */
export function evaluateFdUsage(fds: number, softLimit: number): FdUsage {
  if (fds < 0 || !softLimit) {
    return { fds, softLimit, ratio: fds >= 0 && softLimit ? fds / softLimit : 0, level: "info" };
  }
  const ratio = fds / softLimit;
  const level = ratio >= ERROR_RATIO ? "error" : ratio >= WARN_RATIO ? "warn" : "info";
  return { fds, softLimit, ratio, level };
}

let timer: ReturnType<typeof setInterval> | null = null;

function logFdUsage(): void {
  const usage = evaluateFdUsage(countOpenFds(), readNofileSoftLimit());
  // 结构化字段统一放 msg 前的绑定对象，便于日志检索/告警抓取。
  logger[usage.level](
    {
      fds: usage.fds,
      softLimit: usage.softLimit,
      ratio: Number(usage.ratio.toFixed(4)),
      code: "FD_USAGE",
    },
    usage.level === "info"
      ? "fd usage nominal"
      : `fd usage ${usage.level}: ${(usage.ratio * 100).toFixed(1)}% of nofile soft limit`,
  );
}

/** 启动周期性 fd 监控（幂等）。intervalMs 主要供测试注入。 */
export function startFdMonitor(intervalMs: number = FD_MONITOR_INTERVAL_MS): void {
  if (timer) return; // 幂等：重复启动复用既有 timer
  timer = setInterval(logFdUsage, intervalMs);
  timer.unref?.(); // 不阻止进程退出
  logFdUsage(); // 启动即记录一次基线
}

export function stopFdMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
