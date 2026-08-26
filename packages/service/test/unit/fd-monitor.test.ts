import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * HALL-18 A3: fd 自监控 — 定期读 /proc/self/fd 数量，超 nofile soft limit
 * 阈值（70% warn / 85% error）时输出结构化日志，为告警留钩子。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../src/infra/logger.js", () => ({
  logger: m,
}));

const { countOpenFds, evaluateFdUsage, readNofileSoftLimit, startFdMonitor, stopFdMonitor } = await import(
  "../../src/infra/fd-monitor.js"
);

describe("fd monitor (HALL-18 A3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => {
    stopFdMonitor();
  });

  it("countOpenFds 反映真实打开的 fd（打开 N 个 fd 后计数上升）", () => {
    const before = countOpenFds();
    expect(before).toBeGreaterThan(0);

    const fds = [openSync(mkdtempSync(join(tmpdir(), "fdmon-")), "r")];
    fds.push(openSync(process.cwd(), "r"));
    const during = countOpenFds();
    for (const fd of fds) closeSync(fd);

    expect(during).toBeGreaterThanOrEqual(before + fds.length);
  });

  it("evaluateFdUsage: <70% → info；70–85% → warn；≥85% → error", () => {
    expect(evaluateFdUsage(1000, 10_000).level).toBe("info");
    expect(evaluateFdUsage(7_000, 10_000).level).toBe("warn");
    expect(evaluateFdUsage(8_500, 10_000).level).toBe("error");
    expect(evaluateFdUsage(9_999, 10_000).level).toBe("error");
  });

  it("evaluateFdUsage 携带比率与阈值字段（告警钩子用）", () => {
    const r = evaluateFdUsage(7_000, 10_000);
    expect(r).toMatchObject({ fds: 7_000, softLimit: 10_000, ratio: 0.7 });
  });

  it("soft limit 未知（0）→ 只计数不分级，不抛错", () => {
    const r = evaluateFdUsage(123, 0);
    expect(r.level).toBe("info");
    expect(r.fds).toBe(123);
    expect(r.softLimit).toBe(0);
  });

  // 阻塞项 1（PR #48 评审）：解析必须对真实 /proc/self/limits 行格式生效。
  // 历史缺陷：trim().split(/\s+/)[1] 取到 "open" → NaN → 永远返回 0 →
  // 70%/85% 告警阈值静默失效。测试样例对齐真实文件的列对齐空格与行尾单位。
  describe("readNofileSoftLimit 真实 limits 格式解析", () => {
    const realLimitsSample = [
      "Limit                     Soft Limit           Hard Limit           Units  ",
      "Max cpu time              unlimited            unlimited            seconds",
      "Max open files            1048576              1048576              files  ",
      "Max processes             unlimited            unlimited            processes",
      "", // 与真实文件一致：尾部空行
    ].join("\n");

    it("真实格式（列对齐空格 + 行尾 files 单位）→ 解析出 soft 值", () => {
      expect(readNofileSoftLimit(realLimitsSample)).toBe(1048576);
    });

    it("本机 /proc/self/limits 实测（Linux 环境）→ 正数值", () => {
      const limit = readNofileSoftLimit(fs.readFileSync("/proc/self/limits", "utf-8"));
      expect(limit).toBeGreaterThan(0);
    });

    it("无 Max open files 行 / unlimited / 空内容 → 0（不抛错）", () => {
      expect(readNofileSoftLimit("Max cpu time              unlimited            unlimited            seconds\n")).toBe(0);
      expect(readNofileSoftLimit("Max open files            unlimited            unlimited            files  ")).toBe(0);
      expect(readNofileSoftLimit("")).toBe(0);
    });
  });

  it("startFdMonitor 周期性记录 fd 用量", async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    m.info.mockImplementation((bindings: unknown) => {
      const b = bindings as { fds?: number };
      if (typeof b?.fds === "number") seen.push(b.fds);
    });

    startFdMonitor(1_000);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("startFdMonitor 幂等（重复启动不叠加定时器）", async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    m.info.mockImplementation((bindings: unknown) => {
      const b = bindings as { fds?: number };
      if (typeof b?.fds === "number") seen.push(b.fds);
    });

    startFdMonitor(1_000);
    startFdMonitor(1_000);
    await vi.advanceTimersByTimeAsync(1_100);
    // 启动基线 1 次 + 周期 1 次 = 2；若重复启动叠加了 timer 则会是 3+。
    expect(seen.length).toBe(2);
  });
});
