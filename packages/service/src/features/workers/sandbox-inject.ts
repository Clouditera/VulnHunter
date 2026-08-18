/**
 * H1 worker SSH injection: renders the runtime files and pushes them into
 * the worker container's tmpfs (/run/vulnhunter) after start.
 *
 * The H1 §7 output key-material leak guard was retired (fish 2026-08-19,
 * PR #38): the generic PEM marker false-positive quarantined targets that
 * legitimately bundle test keys, blocking artifact sync. The agent-facing
 * prohibition in the sandbox usage text remains the first line.
 */

import type Dockerode from "dockerode";
import type { TaskSandbox } from "../sandboxes/storage.js";

export const SANDBOX_RUNTIME_DIR = "/run/vulnhunter";
const SSH_DIR = `${SANDBOX_RUNTIME_DIR}/ssh`;
/** OpenSSH drop-in so bare `ssh vulnhunter-sandbox` works without -F (fish 2026-08-02). */
// The system drop-in (/etc/ssh/ssh_config.d/99-vulnhunter.conf → Include the
// tmpfs config) is baked into the worker image at build time — runtime
// injection must not touch /etc (de-identified workers can't, 2026-08-05
// continue-scan EACCES). ssh skips the Include silently for static tasks.

export interface SandboxConnection {
  host: string;
  port: number;
  user: string;
}

/** Optional bastion jump (SANDBOX_SSH_BASTION=user@host[:port]). */
export interface BastionJump {
  user: string;
  host: string;
  port: number;
  /** OpenSSH host public key line for bastion pin (required when bastion set). */
  hostPublicKey?: string | null;
  /** When true, inject IdentityFile for bastion_id private key. */
  hasIdentityFile?: boolean;
}

export interface RenderSshConfigOptions {
  conn: SandboxConnection;
  /** Instance host public key from plane (v0.3.2). Null → TOFU accept-new. */
  hostPublicKey?: string | null;
  /** Bastion jump config; null/undefined = direct port-mapping mode. */
  bastion?: BastionJump | null;
  /** When bastion is set, HostName for the sandbox target (usually internal IP). */
  targetHost?: string | null;
  targetPort?: number | null;
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

/** Parse SANDBOX_SSH_BASTION=user@host[:port] → BastionJump fields (no keys). */
export function parseBastionSpec(spec: string | null | undefined): Omit<BastionJump, "hostPublicKey" | "hasIdentityFile"> | null {
  if (!spec || !spec.trim()) return null;
  const raw = spec.trim();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  const user = raw.slice(0, at);
  const hostPort = raw.slice(at + 1);
  // [ipv6]:port or host:port or host
  let host = hostPort;
  let port = 22;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (bracket) {
    host = bracket[1]!;
    if (bracket[2]) port = Number(bracket[2]);
  } else {
    const colon = hostPort.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(hostPort.slice(colon + 1))) {
      host = hostPort.slice(0, colon);
      port = Number(hostPort.slice(colon + 1));
    }
  }
  if (!user || !host) return null;
  return { user, host, port };
}

/** Format one known_hosts line. Public key may be "type base64 [comment]" or bare base64 (assume ssh-ed25519). */
export function formatKnownHostsEntry(host: string, port: number, publicKey: string): string {
  const key = publicKey.trim();
  const keyPart = key.startsWith("ssh-") || key.startsWith("ecdsa-") || key.startsWith("rsa-")
    ? key.split(/\s+/).slice(0, 2).join(" ")
    : `ssh-ed25519 ${key}`;
  const hostPart = port === 22 ? host : `[${host}]:${port}`;
  return `${hostPart} ${keyPart}`;
}

export function renderKnownHosts(entries: Array<{ host: string; port: number; publicKey: string }>): string {
  if (entries.length === 0) return "";
  return entries.map((e) => formatKnownHostsEntry(e.host, e.port, e.publicKey)).join("\n") + "\n";
}

/**
 * Render OpenSSH client config.
 * - bastion mode: ProxyJump + full pin on both hops when keys present
 * - direct mode: pin when hostPublicKey present, else TOFU accept-new
 */
export function renderSshConfig(connOrOpts: SandboxConnection | RenderSshConfigOptions): string {
  const opts: RenderSshConfigOptions = "conn" in connOrOpts && connOrOpts.conn
    ? connOrOpts as RenderSshConfigOptions
    : { conn: connOrOpts as SandboxConnection };
  const conn = opts.conn;
  const bastion = opts.bastion ?? null;
  const pinTarget = Boolean(opts.hostPublicKey && opts.hostPublicKey.trim());
  const targetHost = (opts.targetHost && opts.targetHost.trim()) || conn.host;
  const targetPort = opts.targetPort ?? conn.port;

  if (bastion) {
    const pinBastion = Boolean(bastion.hostPublicKey && bastion.hostPublicKey.trim());
    const bastionIdentity = bastion.hasIdentityFile
      ? `  IdentityFile ${SSH_DIR}/bastion_id\n  IdentitiesOnly yes\n`
      : "";
    const bastionCheck = pinBastion ? "yes" : "accept-new";
    const targetCheck = pinTarget ? "yes" : "accept-new";
    return `Host vulnhunter-bastion
  HostName ${bastion.host}
  Port ${bastion.port}
  User ${bastion.user}
${bastionIdentity}  UserKnownHostsFile ${SSH_DIR}/known_hosts
  StrictHostKeyChecking ${bastionCheck}
  ServerAliveInterval 30
  ServerAliveCountMax 10

Host vulnhunter-sandbox
  HostName ${targetHost}
  Port ${targetPort}
  User ${conn.user}
  IdentityFile ${SSH_DIR}/id_ed25519
  IdentitiesOnly yes
  ProxyJump vulnhunter-bastion
  UserKnownHostsFile ${SSH_DIR}/known_hosts
  StrictHostKeyChecking ${targetCheck}
  ServerAliveInterval 30
  ServerAliveCountMax 10
`;
  }

  const check = pinTarget ? "yes" : "accept-new";
  return `Host vulnhunter-sandbox
  HostName ${conn.host}
  Port ${conn.port}
  User ${conn.user}
  IdentityFile ${SSH_DIR}/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ${SSH_DIR}/known_hosts
  StrictHostKeyChecking ${check}
  ServerAliveInterval 30
  ServerAliveCountMax 10
`;
}

export function renderSandboxMd(capabilities: string[]): string {
  const capLine = capabilities.includes("docker")
    ? "- 沙箱内已具备 docker/compose（按所选 profile 能力为准）"
    : "- 沙箱能力以所选 profile 为准（本实例不含内部 docker）";
  return `使用 \`ssh vulnhunter-sandbox\` 可以连接到本任务的沙箱环境（scp 同别名可用）。

- 远程工作目录：/home/sandbox/vulnhunter-work（每次命令显式 cd；ssh 无状态；目录可能尚未创建，首次使用先执行 mkdir -p /home/sandbox/vulnhunter-work）
- 所有目标构建、运行、触发、验证命令必须通过该 ssh 连接在沙箱内执行；不要在本机运行目标
- 文件上传/下载使用 \`scp <local> vulnhunter-sandbox:<remote>\` / \`scp vulnhunter-sandbox:<remote> <local>\`
- 禁止读取或输出 SSH 私钥内容；禁止把任何 key material 写入产物
${capLine}
`;
}

export interface InjectionFile {
  containerPath: string;
  content: string;
  mode: number;
}

export interface RenderInjectionOptions {
  sshHostOverride?: string | null;
  bastionSpec?: string | null;
  bastionHostKey?: string | null;
  bastionIdentityOpenSsh?: string | null;
}

export function renderInjectionFiles(
  mapping: TaskSandbox,
  privateKeyOpenSsh: string,
  sshHostOverrideOrOpts?: string | null | RenderInjectionOptions,
): InjectionFile[] {
  const opts: RenderInjectionOptions =
    sshHostOverrideOrOpts && typeof sshHostOverrideOrOpts === "object"
      ? sshHostOverrideOrOpts
      : { sshHostOverride: sshHostOverrideOrOpts as string | null | undefined };

  const publishedHost = resolveWorkerSshHost(mapping.ssh_host ?? "", opts.sshHostOverride);
  const conn: SandboxConnection = {
    host: publishedHost,
    port: mapping.ssh_port ?? 22,
    user: mapping.ssh_user ?? "sandbox",
  };
  const hostPublicKey = mapping.ssh_host_public_key ?? mapping.host_key ?? null;
  const bastionParsed = parseBastionSpec(opts.bastionSpec);
  const bastion: BastionJump | null = bastionParsed
    ? {
        ...bastionParsed,
        hostPublicKey: opts.bastionHostKey ?? null,
        hasIdentityFile: Boolean(opts.bastionIdentityOpenSsh?.trim()),
      }
    : null;

  // Bastion mode: jump to internal host on port 22; direct mode: published host:port.
  const targetHost = bastion
    ? (mapping.ssh_internal_host?.trim() || publishedHost)
    : publishedHost;
  const targetPort = bastion ? 22 : conn.port;

  const knownEntries: Array<{ host: string; port: number; publicKey: string }> = [];
  if (bastion?.hostPublicKey?.trim()) {
    knownEntries.push({ host: bastion.host, port: bastion.port, publicKey: bastion.hostPublicKey });
  }
  if (hostPublicKey?.trim()) {
    knownEntries.push({ host: targetHost, port: targetPort, publicKey: hostPublicKey });
  }

  const files: InjectionFile[] = [
    { containerPath: `${SSH_DIR}/id_ed25519`, content: privateKeyOpenSsh, mode: 0o400 },
    { containerPath: `${SSH_DIR}/known_hosts`, content: renderKnownHosts(knownEntries), mode: 0o444 },
    {
      containerPath: `${SSH_DIR}/config`,
      content: renderSshConfig({
        conn,
        hostPublicKey,
        bastion,
        targetHost,
        targetPort,
      }),
      mode: 0o444,
    },
    // sandbox.md retired from the tmpfs injection (engine-native gate,
    // 2026-08-19): the agent-facing sandbox description now lives in the
    // workspace file out/.sandbox_config (written by apply_sandbox /
    // re-rendered on continue-resume), never in /run/vulnhunter.
  ];
  if (opts.bastionIdentityOpenSsh?.trim()) {
    files.splice(1, 0, {
      containerPath: `${SSH_DIR}/bastion_id`,
      content: opts.bastionIdentityOpenSsh,
      mode: 0o400,
    });
  }
  return files;
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
