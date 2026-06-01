import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface VersionInfo {
  product: string;
  version: string;
  buildTime?: string;
  gitCommit?: string;
  youngflowVersion?: string;
  licenseSchema: string;
}

let cached: VersionInfo | null = null;

function readJson(path: string): Partial<VersionInfo> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<VersionInfo>;
  } catch {
    return null;
  }
}

export function getVersionInfo(): VersionInfo {
  if (cached) return cached;
  const envVersion = process.env.VULNAGENT_VERSION;
  const manifest = readJson("/app/VERSION.json") ?? readJson(join(process.cwd(), "VERSION.json"));
  const pkg = readJson(join(process.cwd(), "../../package.json")) ?? readJson(join(process.cwd(), "package.json"));
  cached = {
    product: manifest?.product ?? "vulnagent",
    version: envVersion ?? manifest?.version ?? pkg?.version ?? "unknown",
    buildTime: manifest?.buildTime,
    gitCommit: manifest?.gitCommit,
    youngflowVersion: manifest?.youngflowVersion,
    licenseSchema: manifest?.licenseSchema ?? "v1",
  };
  return cached;
}

export function resetVersionInfoForTest(): void {
  cached = null;
}
