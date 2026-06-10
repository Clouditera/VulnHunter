import { execFile } from "node:child_process";

const LS_REMOTE_TIMEOUT_MS = 15_000;
const MAX_GIT_URL_LENGTH = 2_000;

export const USER_REPO_UNREACHABLE = "无法访问该源码仓库，请检查仓库地址和分支是否正确，或改用上传 ZIP 压缩包的方式创建任务。";

export class GitRemoteError extends Error {
  code: "ERR_INVALID_GIT_URL" | "ERR_GIT_REMOTE_UNREACHABLE";
  status: 400 | 502;

  constructor(code: GitRemoteError["code"], message: string, status: GitRemoteError["status"] = 400) {
    super(message);
    this.name = "GitRemoteError";
    this.code = code;
    this.status = status;
  }
}

export function validateRemoteGitUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim();
  if (!trimmed || trimmed.length > MAX_GIT_URL_LENGTH) {
    throw new GitRemoteError("ERR_INVALID_GIT_URL", "Invalid git URL");
  }
  // Defense-in-depth: execFile avoids shell injection, but git still treats
  // leading-dash repository arguments as options (e.g. --upload-pack=...).
  if (trimmed.startsWith("-")) {
    throw new GitRemoteError("ERR_INVALID_GIT_URL", "Invalid git URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GitRemoteError("ERR_INVALID_GIT_URL", "Invalid git URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GitRemoteError("ERR_INVALID_GIT_URL", "Only http(s) git URLs are supported");
  }
  return trimmed;
}

function runGitLsRemote(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", ...args],
      { timeout: LS_REMOTE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(new GitRemoteError("ERR_GIT_REMOTE_UNREACHABLE", USER_REPO_UNREACHABLE, 502));
        else resolve(stdout);
      },
    );
  });
}

export function parseDefaultBranch(symrefOutput: string): string | null {
  for (const line of symrefOutput.split(/\r?\n/)) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function parseRemoteBranches(headsOutput: string): string[] {
  const branches = new Set<string>();
  for (const line of headsOutput.split(/\r?\n/)) {
    const match = line.match(/^[0-9a-fA-F]+\s+refs\/heads\/(.+)$/);
    if (match?.[1]) branches.add(match[1].trim());
  }
  return [...branches].sort((a, b) => a.localeCompare(b));
}

export async function getRemoteDefaultBranch(gitUrl: string): Promise<string | null> {
  const safeUrl = validateRemoteGitUrl(gitUrl);
  const out = await runGitLsRemote(["--symref", "--", safeUrl, "HEAD"]);
  return parseDefaultBranch(out);
}

export async function listRemoteBranches(gitUrl: string): Promise<{ default_branch: string | null; branches: string[] }> {
  const safeUrl = validateRemoteGitUrl(gitUrl);
  const [symref, heads] = await Promise.all([
    runGitLsRemote(["--symref", "--", safeUrl, "HEAD"]),
    runGitLsRemote(["--heads", "--", safeUrl]),
  ]);
  const branches = parseRemoteBranches(heads);
  const defaultBranch = parseDefaultBranch(symref);
  return {
    default_branch: defaultBranch,
    branches: defaultBranch && !branches.includes(defaultBranch) ? [defaultBranch, ...branches] : branches,
  };
}
