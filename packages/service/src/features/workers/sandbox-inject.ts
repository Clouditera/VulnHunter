/**
 * H1 worker SSH injection: renders the four runtime files and pushes them
 * into the worker container's tmpfs (/run/vulnagent) after create, before
 * start. Also the §7 output key-material leak scan (defense in depth).
 */

import { logger } from "../../infra/logger.js";
import type Dockerode from "dockerode";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DbTask } from "../tasks/storage.js";
import type { TaskSandbox } from "../sandboxes/storage.js";

export const SANDBOX_RUNTIME_DIR = "/run/vulnagent";
export const SANDBOX_CFG_CONTAINER_PATH = `${SANDBOX_RUNTIME_DIR}/sandbox.md`;
const SSH_DIR = `${SANDBOX_RUNTIME_DIR}/ssh`;

export interface SandboxConnection {
  host: string;
  port: number;
  user: string;
}

/** Loopback coordinates are the plane's own perspective — unreachable from a
 * worker container. Translate to the host-gateway alias (ExtraHosts maps it).
 * A deployment with a remote plane should set SANDBOX_SSH_HOST_OVERRIDE. */
export function resolveWorkerSshHost(reportedHost: string, override?: string | null): string {
  if (override && override.trim()) return override.trim();
  if (reportedHost === "127.0.0.1" || reportedHost === "localhost" || reportedHost === "::1") {
    return "host.docker.internal";
  }
  return reportedHost;
}

export function renderSshConfig(conn: SandboxConnection): string {
  return `Host vulnagent-sandbox
  HostName ${conn.host}
  Port ${conn.port}
  User ${conn.user}
  IdentityFile ${SSH_DIR}/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ${SSH_DIR}/known_hosts
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
  ServerAliveCountMax 10
`;
}

export function renderSandboxMd(capabilities: string[]): string {
  const capLine = capabilities.includes("docker")
    ? "- 沙箱内已具备 docker/compose（按所选 profile 能力为准）"
    : "- 沙箱能力以所选 profile 为准（本实例不含内部 docker）";
  return `使用 \`ssh vulnagent-sandbox\` 可以连接到本任务的沙箱环境（scp 同别名可用）。

- 远程工作目录：/home/sandbox/vulnagent-work（每次命令显式 cd；ssh 无状态）
- 所有目标构建、运行、触发、验证命令必须通过该 ssh 连接在沙箱内执行；不要在本机运行目标
- 文件上传/下载使用 \`scp <local> vulnagent-sandbox:<remote>\` / \`scp vulnagent-sandbox:<remote> <local>\`
- 禁止读取或输出 SSH 私钥内容；禁止把任何 key material 写入产物
${capLine}
`;
}

export interface InjectionFile {
  containerPath: string;
  content: string;
  mode: number;
}

export function renderInjectionFiles(task: DbTask, mapping: TaskSandbox, privateKeyOpenSsh: string, sshHostOverride?: string | null): InjectionFile[] {
  const conn: SandboxConnection = {
    host: resolveWorkerSshHost(mapping.ssh_host ?? "", sshHostOverride),
    port: mapping.ssh_port ?? 22,
    user: mapping.ssh_user ?? "sandbox",
  };
  const capabilities = ((task.metadata as Record<string, unknown> | undefined)?.prepare as { sandbox_capabilities?: string[] } | undefined)?.sandbox_capabilities ?? [];
  return [
    { containerPath: `${SSH_DIR}/id_ed25519`, content: privateKeyOpenSsh, mode: 0o400 },
    // Empty until SandboxPlane #7 (create returns the instance host key); TOFU accept-new meanwhile.
    { containerPath: `${SSH_DIR}/known_hosts`, content: "", mode: 0o444 },
    { containerPath: `${SSH_DIR}/config`, content: renderSshConfig(conn), mode: 0o444 },
    { containerPath: SANDBOX_CFG_CONTAINER_PATH, content: renderSandboxMd(capabilities), mode: 0o444 },
  ];
}

/** Build a tar stream with the injection files and push it into the container. */
// Minimal ustar builder (regular files only) — avoids a new dependency for
// the tiny injection payload (dockerode's transitive tar-stream stays unused).
function tarHeader(name: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const write = (offset: number, length: number, value: string) => header.write(value, offset, length, "ascii");
  write(0, 100, name);
  write(100, 8, mode.toString(8).padStart(7, "0") + "\0");
  write(108, 8, "0000000\0"); // uid 0
  write(116, 8, "0000000\0"); // gid 0
  write(124, 12, size.toString(8).padStart(11, "0") + "\0");
  write(136, 12, "00000000000\0"); // mtime 0 (deterministic)
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header[156] = "0".charCodeAt(0); // typeflag: regular file
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

export function buildInjectionTar(files: InjectionFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const name = file.containerPath.replace(/^\//, "");
    const body = Buffer.from(file.content);
    chunks.push(tarHeader(name, body.length, file.mode));
    chunks.push(body);
    const remainder = body.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // end-of-archive marker
  return Buffer.concat(chunks);
}

/**
 * Push the injection files into the container's tmpfs. The docker PUT
 * /archive API works host-side and can NEVER see the container's tmpfs
 * namespace (proven 2026-07-18) — injection must run in-namespace via exec.
 * Payloads travel on stdin (never argv): nothing lands in `docker inspect`
 * exec config, the host process list, or any log.
 */
export async function injectSandboxFiles(container: Dockerode.Container, files: InjectionFile[]): Promise<void> {
  const scriptLines: string[] = ["set -eu"];
  for (const file of files) {
    const dir = file.containerPath.slice(0, file.containerPath.lastIndexOf("/"));
    scriptLines.push(`mkdir -p ${dir}`);
    scriptLines.push(`base64 -d > ${file.containerPath} <<'VA_H1_EOF'`);
    scriptLines.push(Buffer.from(file.content).toString("base64"));
    scriptLines.push("VA_H1_EOF");
    scriptLines.push(`chmod ${file.mode.toString(8)} ${file.containerPath}`);
  }
  const script = scriptLines.join("\n") + "\n";

  const exec = await container.exec({
    Cmd: ["/bin/sh", "-s"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const output: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => output.push(chunk));
  stream.end(script);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const inspect = await exec.inspect();
  if (inspect.ExitCode !== 0) {
    const tail = Buffer.concat(output).toString("utf8").slice(-400);
    throw new Error(`Sandbox file injection failed (exit ${inspect.ExitCode}): ${tail}`);
  }
}

// ---------------------------------------------------------------------------
// H1 §7: key-material leak scan before outputs leave the workspace.
// Scans business-artifact dirs (not .youngflow — LLM session logs are huge
// and never a scp target). A hit quarantines: sync is skipped and the task
// gets a visible security anomaly. Expected to never fire.
// ---------------------------------------------------------------------------
const KEY_MATERIAL_MARKER = "PRIVATE KEY-----";
const SCAN_SUBDIRS = ["findings", "risks", "knowledge", "todo", "done", "exploits", "leads", "report", "wiki"];
const MAX_SCAN_FILE_BYTES = 16 * 1024 * 1024;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing dir is fine (static tasks have no dynamic artifacts)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function scanOutputsForKeyMaterial(outDir: string): Promise<string[]> {
  const hits: string[] = [];
  for (const sub of SCAN_SUBDIRS) {
    for await (const file of walk(join(outDir, sub))) {
      try {
        const info = await stat(file);
        if (info.size > MAX_SCAN_FILE_BYTES) continue;
        const content = await readFile(file);
        if (content.includes(KEY_MATERIAL_MARKER)) hits.push(file);
      } catch (error) {
        logger.debug({ err: error, file }, "Leak-scan skipped unreadable file");
      }
    }
  }
  return hits;
}
