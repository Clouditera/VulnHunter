import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * HALL-18 A1: 变更检测 — 增量同步只上传新增/变更文件（manifest: path →
 * {size, mtimeMs}），首轮全量；A2: put 并发上限 + stream 生命周期受控
 * （putObject + finally destroy），替代无界顺序 fPutObject。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  // fake object store: key → Buffer（putObject 收到的完整内容）
  objects: new Map<string, Buffer>(),
  puts: [] as string[],
  putObjectCalls: 0,
  /** 并发观察：putObject 在途时记录最大同时 in-flight 数 */
  inFlight: 0,
  maxInFlight: 0,
  destroyedStreams: 0,
  /** A2 验证：每个 putObject 收到的流实例（检查 destroy） */
  seenStreams: [] as any[],
}));

/** 默认实现：收集内容、观测并发；mockImplementationOnce 在其上叠加失败注入。 */
const defaultPut = async (_b: string, key: string, stream: any, size?: number, metaData?: any) => {
  m.putObjectCalls++;
  m.inFlight++;
  m.maxInFlight = Math.max(m.maxInFlight, m.inFlight);
  m.seenStreams.push(stream);
  try {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    m.objects.set(key, Buffer.concat(chunks));
    m.puts.push(key);
    void size;
    void metaData;
  } finally {
    m.inFlight--;
    if (stream.destroyed) m.destroyedStreams++;
  }
};

const putObject = vi.fn(defaultPut);

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({ putObject }),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/features/workers/docker-client.js", () => ({
  ensureWorkDir: vi.fn(),
}));

const { syncOutputsToMinio } = await import("../../src/features/workers/sync-outputs.js");

const dataDir = mkdtempSync(join(tmpdir(), "va-sync-changed-"));
const taskId = "task-hall18";
const outDir = join(dataDir, "workspaces", taskId, "out");
const manifestPath = join(dataDir, "workspaces", taskId, ".out-sync-manifest.json");
const INCLUDE = ["findings", "risks", "knowledge"];

const config = { dataDir, minio: { bucket: "artifact-store" } } as never;

function seed() {
  rmSync(join(dataDir, "workspaces"), { recursive: true, force: true });
  m.objects.clear();
  m.puts.length = 0;
  m.putObjectCalls = 0;
  m.maxInFlight = 0;
  m.destroyedStreams = 0;
  m.seenStreams.length = 0;
  mkdirSync(join(outDir, "findings"), { recursive: true });
  writeFileSync(join(outDir, "findings", "BUG-1.yaml"), "metadata: {v: 1}\n");
}

describe("syncOutputsToMinio 变更检测（HALL-18 A1/A2）", () => {
  beforeEach(seed);
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("首轮增量同步全量上传并落 manifest", async () => {
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(1);
    expect(m.puts).toEqual([`scan-outputs/${taskId}/findings/BUG-1.yaml`]);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest["findings/BUG-1.yaml"]).toMatchObject({
      size: expect.any(Number),
      mtimeMs: expect.any(Number),
    });
  });

  it("无变更的第二轮零上传（幂等）", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    m.putObjectCalls = 0;
    m.puts.length = 0;
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(0);
    expect(m.putObjectCalls).toBe(0);
  });

  it("仅变更/新增文件被重传（size+mtime 变化检测）", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    m.putObjectCalls = 0;
    m.puts.length = 0;

    // 修改既有文件（内容变化 → size 变）
    writeFileSync(join(outDir, "findings", "BUG-1.yaml"), "metadata: {v: 2, bigger}\n");
    // 新增文件
    mkdirSync(join(outDir, "risks"), { recursive: true });
    writeFileSync(join(outDir, "risks", "RISK-9.yaml"), "metadata: {}\n");

    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(2);
    expect(m.puts.sort()).toEqual([
      `scan-outputs/${taskId}/findings/BUG-1.yaml`,
      `scan-outputs/${taskId}/risks/RISK-9.yaml`,
    ]);
  });

  it("mtime 变化但 size 不变也触发重传（mtime 参与指纹）", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    m.putObjectCalls = 0;

    const p = join(outDir, "findings", "BUG-1.yaml");
    const now = new Date();
    utimesSync(p, now, new Date(now.getTime() + 5000));

    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(1);
  });

  it("上传失败的文件不进入 manifest，下轮重试", async () => {
    putObject.mockImplementationOnce(async () => {
      throw new Error("transient network error");
    });

    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest["findings/BUG-1.yaml"]).toBeUndefined();

    // 下一轮（默认实现）→ 补传
    const n2 = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n2).toBe(1);
    expect(m.objects.get(`scan-outputs/${taskId}/findings/BUG-1.yaml`)?.toString()).toContain(
      "v: 1",
    );
  });

  it("损坏的 manifest 触发全量重传（安全回退）", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    m.putObjectCalls = 0;
    m.puts.length = 0;
    writeFileSync(manifestPath, "{corrupt");

    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(1);
    expect(m.putObjectCalls).toBe(1);
  });

  it("终端全量同步（无 includeDirs）不受增量 manifest 跳过 — 全树重传", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    m.putObjectCalls = 0;
    m.puts.length = 0;
    mkdirSync(join(outDir, ".youngflow", "sessions"), { recursive: true });
    writeFileSync(join(outDir, ".youngflow", "sessions", "session.jsonl"), "{}\n");

    const n = await syncOutputsToMinio(taskId, config);
    expect(n).toBe(2);
    expect(m.puts.some((k) => k.includes(".youngflow/sessions/"))).toBe(true);
  });

  it("put 并发受上限约束（大量文件时 maxInFlight <= 16）", async () => {
    // 45 个小文件（避开与 seed BUG-1 同名），验证并发上限生效且全部上传
    for (let i = 0; i < 45; i++) {
      writeFileSync(join(outDir, "findings", `EXTRA-${i}.yaml`), `metadata: {i: ${i}}\n`);
    }
    // 首轮 manifest 为空 → 46 个全部 pending；快速返回的 mock 下并发观测
    // 以“不超过上限”为准（微任务调度可能退化为串行）。
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(46);
    expect(m.putObjectCalls).toBe(46);
    expect(m.maxInFlight).toBeLessThanOrEqual(16);
  });

  it("上传内容与本地一致（putObject 流被完整消费）", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(m.objects.get(`scan-outputs/${taskId}/findings/BUG-1.yaml`)?.toString()).toBe(
      "metadata: {v: 1}\n",
    );
  });

  it("A2 生命周期：成功路径每个流都被 destroy（fd 必关）", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(m.seenStreams.length).toBe(1);
    expect(m.seenStreams[0].destroyed).toBe(true);
  });

  it("A2 生命周期：putObject 抛错 → 流仍被 destroy，不悬挂", async () => {
    putObject.mockImplementationOnce(async (_b: string, _k: string, stream: any) => {
      m.seenStreams.push(stream);
      throw new Error("network down mid-upload");
    });
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    const s = m.seenStreams[m.seenStreams.length - 1];
    expect(s.destroyed).toBe(true);
  });

  it("建议项 3：manifest 原子写入（tmp+rename）— 无 .tmp 残留，内容完整，下轮幂等", async () => {
    await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    const wsDir = join(dataDir, "workspaces", taskId);
    // 无 tmp 残留
    expect(readdirSync(wsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // 内容完整可读（JSON 解析成功且包含已上传键）
    const manifest = JSON.parse(readFileSync(join(wsDir, ".out-sync-manifest.json"), "utf-8"));
    expect(manifest["findings/BUG-1.yaml"]).toBeDefined();
    // 下一轮基于该清单正常幂等（零上传）
    m.putObjectCalls = 0;
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: INCLUDE });
    expect(n).toBe(0);
  });
});
