import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let installationId = "";

export function initInstallation(dataDir: string): void {
  const filePath = join(dataDir, ".install_id");
  if (existsSync(filePath)) {
    installationId = readFileSync(filePath, "utf-8").trim();
    return;
  }
  mkdirSync(dataDir, { recursive: true });
  installationId = randomUUID();
  writeFileSync(filePath, installationId, { mode: 0o644 });
}

export function getInstallationId(): string {
  return installationId;
}
