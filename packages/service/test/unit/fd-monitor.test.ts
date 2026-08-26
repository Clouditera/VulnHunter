import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
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

const { countOpenFds, evaluateFdUsage, startFdMonitor, stopFdMonitor } = await import(
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
