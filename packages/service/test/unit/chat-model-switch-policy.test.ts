import { describe, expect, it } from "vitest";
import { ChatSession, shouldForwardModelSwitch } from "../../src/features/chat/chat-session.js";

describe("shouldForwardModelSwitch", () => {
  it("persists selection without starting a worker before the first prompt", () => {
    expect(shouldForwardModelSwitch("idle")).toBe(false);
  });

  it("does not start a worker when changing an untouched session", async () => {
    const session = new ChatSession("11111111-1111-4111-8111-111111111111");
    await expect(session.setModel("credential-id")).resolves.toBeUndefined();
  });

  it("defers switching while a stopped worker is recovering", () => {
    expect(shouldForwardModelSwitch("recovering")).toBe(false);
  });

  it.each(["starting", "ready", "active"] as const)(
    "forwards the switch to an existing %s worker",
    (state) => {
      expect(shouldForwardModelSwitch(state)).toBe(true);
    },
  );
});
