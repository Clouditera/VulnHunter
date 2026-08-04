import { describe, expect, it } from "vitest";
import { PI_VERSION } from "@vulnhunter/shared";

describe("pi version pin", () => {
  it("PI_VERSION is a semver string", () => {
    expect(PI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("PI_VERSION matches all Dockerfiles ARG defaults", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const dockerfiles = [
      "worker.Dockerfile",
      "service.Dockerfile",
      "service.community.Dockerfile",
    ];
    for (const df of dockerfiles) {
      const dockerfile = await readFile(
        resolve(__dirname, `../../../../deploy/dockerfiles/${df}`),
        "utf8",
      );
      const m = dockerfile.match(/ARG PI_VERSION=(\S+)/);
      expect(m, `${df} must have ARG PI_VERSION`).not.toBeNull();
      expect(m![1]).toBe(PI_VERSION);
    }
  });

  it("pi-ai is importable (smoke)", async () => {
    const mod = await import("@earendil-works/pi-ai");
    expect(typeof mod.createAssistantMessageEventStream).toBe("function");
    expect(typeof mod.getSupportedThinkingLevels).toBe("function");
  });
});
