import { describe, expect, it, vi } from "vitest";
import { RpcCommandTracker } from "../../src/rpc-command-tracker.js";

describe("RpcCommandTracker", () => {
  it("resolves only after the matching successful pi response", async () => {
    const write = vi.fn(() => true);
    const tracker = new RpcCommandTracker(write, 100);

    const pending = tracker.send({ type: "set_model", provider: "p", modelId: "m" });
    const command = JSON.parse(write.mock.calls[0][0]);

    expect(tracker.accept({ type: "response", id: "other", success: true })).toBe(false);
    expect(tracker.accept({ type: "response", id: command.id, success: true })).toBe(true);
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it("rejects when pi reports that the model switch failed", async () => {
    const write = vi.fn(() => true);
    const tracker = new RpcCommandTracker(write, 100);

    const pending = tracker.send({ type: "set_model", provider: "missing", modelId: "m" });
    const command = JSON.parse(write.mock.calls[0][0]);
    tracker.accept({ type: "response", id: command.id, success: false, error: "Unknown model" });

    await expect(pending).rejects.toThrow("Unknown model");
  });

  it("rejects when the command cannot be written", async () => {
    const tracker = new RpcCommandTracker(() => false, 100);
    await expect(tracker.send({ type: "set_model" })).rejects.toThrow("pi not running");
  });
});
