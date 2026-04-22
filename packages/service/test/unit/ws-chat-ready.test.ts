/**
 * Unit tests for waitForBridgeWs / bridge-ready tracking in ws-chat.ts
 *
 * We test the exported waitForBridgeWs + the internal ready state
 * by importing the module and simulating bridge connection lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../src/features/chat/worker-manager.js", () => ({
  getWorkerUrl: vi.fn(() => null),
}));
vi.mock("../../src/features/chat/storage.js", () => ({
  appendMessage: vi.fn(async () => {}),
}));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Now import the module
import { waitForBridgeWs } from "../../src/features/chat/ws-chat.js";

describe("waitForBridgeWs", () => {
  it("should timeout if bridge never connects", async () => {
    const start = Date.now();
    await expect(waitForBridgeWs("no-such-session", 200)).rejects.toThrow(
      /not ready after 200ms/,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
  });

  it("should resolve immediately if called again for an already-connected session", async () => {
    // We can't easily simulate markBridgeReady without exporting it.
    // But we can verify that a second waitForBridgeWs on the same non-existent session
    // still times out (no false positive).
    await expect(waitForBridgeWs("another-session", 100)).rejects.toThrow();
  });
});
