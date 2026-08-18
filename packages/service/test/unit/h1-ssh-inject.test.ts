import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateTaskSshKeypair } from "../../src/features/sandboxes/ssh-keys.js";
import {
  buildInjectionTar,
  formatKnownHostsEntry,
  parseBastionSpec,
  renderInjectionFiles,
  renderKnownHosts,
  renderSandboxMd,
  renderSshConfig,
  resolveWorkerSshHost,
} from "../../src/features/workers/sandbox-inject.js";

function hasSshKeygen(): boolean {
  try {
    execFileSync("ssh-keygen", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("generateTaskSshKeypair (OpenSSH formats)", () => {
  it("produces a valid public line and an OpenSSH private key file", () => {
    const kp = generateTaskSshKeypair();
    expect(kp.publicKeyOpenSsh).toMatch(/^ssh-ed25519 AAAA/);
    expect(kp.privateKeyOpenSsh).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(kp.privateKeyOpenSsh).toContain("-----END OPENSSH PRIVATE KEY-----");
    // distinct keys per call
    expect(generateTaskSshKeypair().publicKeyOpenSsh).not.toBe(kp.publicKeyOpenSsh);
  });

  it("ssh-keygen round-trips the private key to the same public key", () => {
    if (!hasSshKeygen()) return; // environment without openssh client
    const dir = mkdtempSync(join(tmpdir(), "h1-keygen-"));
    try {
      const kp = generateTaskSshKeypair();
      const keyPath = join(dir, "id");
      writeFileSync(keyPath, kp.privateKeyOpenSsh, { mode: 0o600 });
      const derived = execFileSync("ssh-keygen", ["-y", "-f", keyPath]).toString().trim();
      // ssh-keygen appends the stored comment; compare the key material prefix
      expect(derived.split(" ").slice(0, 2).join(" ")).toBe(kp.publicKeyOpenSsh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveWorkerSshHost", () => {
  it("translates plane-perspective loopback to the host-gateway alias", () => {
    expect(resolveWorkerSshHost("127.0.0.1")).toBe("host.docker.internal");
    expect(resolveWorkerSshHost("localhost")).toBe("host.docker.internal");
    expect(resolveWorkerSshHost("::1")).toBe("host.docker.internal");
  });
  it("keeps real addresses and honors the deployment override", () => {
    expect(resolveWorkerSshHost("10.0.0.9")).toBe("10.0.0.9");
    expect(resolveWorkerSshHost("127.0.0.1", "192.0.2.102")).toBe("192.0.2.102");
    expect(resolveWorkerSshHost("10.0.0.9", "  ")).toBe("10.0.0.9");
  });
});

describe("renderSshConfig / renderSandboxMd", () => {
  it("ssh config pins identity, TOFU accept-new when no host key, alias and coordinates", () => {
    const cfg = renderSshConfig({ host: "host.docker.internal", port: 32771, user: "sandbox" });
    expect(cfg).toContain("Host vulnhunter-sandbox");
    expect(cfg).toContain("HostName host.docker.internal");
    expect(cfg).toContain("Port 32771");
    expect(cfg).toContain("IdentityFile /run/vulnhunter/ssh/id_ed25519");
    expect(cfg).toContain("IdentitiesOnly yes");
    expect(cfg).toContain("StrictHostKeyChecking accept-new");
  });
  it("pins host key with StrictHostKeyChecking yes when public key provided", () => {
    const cfg = renderSshConfig({
      conn: { host: "host.docker.internal", port: 32771, user: "sandbox" },
      hostPublicKey: "ssh-ed25519 AAAATEST",
    });
    expect(cfg).toContain("StrictHostKeyChecking yes");
    expect(cfg).not.toContain("accept-new");
  });
  it("bastion mode emits ProxyJump + dual Host blocks", () => {
    const cfg = renderSshConfig({
      conn: { host: "host.docker.internal", port: 32771, user: "sandbox" },
      hostPublicKey: "ssh-ed25519 AAAASAND",
      bastion: {
        user: "jump",
        host: "bastion.internal",
        port: 22,
        hostPublicKey: "ssh-ed25519 AAAABAST",
        hasIdentityFile: true,
      },
      targetHost: "172.18.0.7",
      targetPort: 22,
    });
    expect(cfg).toContain("Host vulnhunter-bastion");
    expect(cfg).toContain("HostName bastion.internal");
    expect(cfg).toContain("IdentityFile /run/vulnhunter/ssh/bastion_id");
    expect(cfg).toContain("ProxyJump vulnhunter-bastion");
    expect(cfg).toContain("HostName 172.18.0.7");
    expect(cfg).toContain("Port 22");
    expect(cfg.match(/StrictHostKeyChecking yes/g)?.length).toBe(2);
  });
  it("sandbox.md carries the prohibitions and the capability line", () => {
    const docker = renderSandboxMd(["ssh", "docker", "compose"]);
    expect(docker).toContain("禁止读取或输出 SSH 私钥内容");
    expect(docker).toContain("禁止把任何 key material 写入产物");
    expect(docker).toContain("docker/compose");
    const plain = renderSandboxMd(["ssh"]);
    expect(plain).toContain("不含内部 docker");
  });
});

describe("bastion parse + known_hosts", () => {
  it("parses user@host and user@host:port", () => {
    expect(parseBastionSpec("jump@10.0.0.1")).toEqual({ user: "jump", host: "10.0.0.1", port: 22 });
    expect(parseBastionSpec("jump@10.0.0.1:2222")).toEqual({ user: "jump", host: "10.0.0.1", port: 2222 });
    expect(parseBastionSpec("")).toBeNull();
    expect(parseBastionSpec("nouse")).toBeNull();
  });
  it("formats known_hosts with non-default port brackets", () => {
    expect(formatKnownHostsEntry("h.example", 22, "ssh-ed25519 AAAAX")).toBe("h.example ssh-ed25519 AAAAX");
    expect(formatKnownHostsEntry("h.example", 32771, "ssh-ed25519 AAAAX comment")).toBe("[h.example]:32771 ssh-ed25519 AAAAX");
  });
  it("renderKnownHosts joins entries", () => {
    const kh = renderKnownHosts([
      { host: "b", port: 22, publicKey: "ssh-ed25519 AAAAB" },
      { host: "s", port: 22, publicKey: "ssh-ed25519 AAAAS" },
    ]);
    expect(kh).toContain("b ssh-ed25519 AAAAB");
    expect(kh).toContain("s ssh-ed25519 AAAAS");
    expect(kh.endsWith("\n")).toBe(true);
  });
});

describe("renderInjectionFiles + buildInjectionTar", () => {
  const mapping: any = {
    ssh_host: "127.0.0.1",
    ssh_port: 32771,
    ssh_user: "sandbox",
    ssh_internal_host: "172.18.0.9",
    ssh_host_public_key: "ssh-ed25519 AAAASAND",
  };
  const task: any = { id: "t1", metadata: { prepare: { sandbox_capabilities: ["docker"] } } };
  it("renders injection files with exact paths and modes; pins known_hosts when key present", () => {
    const files = renderInjectionFiles(task, mapping, "PRIVATE", null);
    expect(files.map((f) => [f.containerPath, f.mode])).toEqual([
      ["/run/vulnhunter/ssh/id_ed25519", 0o400],
      ["/run/vulnhunter/ssh/known_hosts", 0o444],
      ["/run/vulnhunter/ssh/config", 0o444],
      ["/run/vulnhunter/sandbox.md", 0o444],
    ]);
    // The /etc drop-in is baked into the worker image at build time (static
    // one-liner) — runtime injection must never touch /etc (de-identified
    // workers can't; 2026-08-05 continue-scan EACCES).
    expect(files.some((f) => f.containerPath.startsWith("/etc/"))).toBe(false);

    expect(files[0]!.content).toBe("PRIVATE");
    expect(files[1]!.content).toContain("[host.docker.internal]:32771 ssh-ed25519 AAAASAND");
    expect(files[2]!.content).toContain("HostName host.docker.internal");
    expect(files[2]!.content).toContain("StrictHostKeyChecking yes");
  });
  it("bastion mode uses internal host + ProxyJump and injects bastion identity", () => {
    const files = renderInjectionFiles(task, mapping, "PRIVATE", {
      bastionSpec: "jump@10.0.0.5:22",
      bastionHostKey: "ssh-ed25519 AAAABAST",
      bastionIdentityOpenSsh: "BASTION_PRIVATE",
    });
    expect(files.some((f) => f.containerPath.endsWith("bastion_id") && f.content === "BASTION_PRIVATE")).toBe(true);
    const cfg = files.find((f) => f.containerPath.endsWith("/config"))!.content;
    expect(cfg).toContain("ProxyJump vulnhunter-bastion");
    expect(cfg).toContain("HostName 172.18.0.9");
    const kh = files.find((f) => f.containerPath.endsWith("known_hosts"))!.content;
    expect(kh).toContain("10.0.0.5 ssh-ed25519 AAAABAST");
    expect(kh).toContain("172.18.0.9 ssh-ed25519 AAAASAND");
  });
  it("TOFU when host public key is null", () => {
    const bare = { ...mapping, ssh_host_public_key: null };
    const files = renderInjectionFiles(task, bare, "PRIVATE", null);
    expect(files.find((f) => f.containerPath.endsWith("known_hosts"))!.content).toBe("");
    expect(files.find((f) => f.containerPath.endsWith("/config"))!.content).toContain("accept-new");
  });
  it("builds a tar that system tar lists with correct modes", () => {
    const files = renderInjectionFiles(task, mapping, "PRIVATE", null);
    const tar = buildInjectionTar(files);
    const dir = mkdtempSync(join(tmpdir(), "h1-tar-"));
    try {
      const tarPath = join(dir, "inj.tar");
      writeFileSync(tarPath, tar);
      const listing = execFileSync("tar", ["-tvf", tarPath]).toString();
      expect(listing).toContain("run/vulnhunter/ssh/id_ed25519");
      expect(listing).not.toContain("etc/ssh");
      expect(listing).toMatch(/-r--------.*id_ed25519/);
      expect(listing).toMatch(/-r--r--r--.*sandbox\.md/);
      // tar extracts cleanly
      execFileSync("tar", ["-xf", tarPath, "-C", dir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
