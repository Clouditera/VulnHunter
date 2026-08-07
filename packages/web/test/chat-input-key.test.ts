import { describe, expect, it } from "vitest";
import { shouldSubmitChatInput } from "../src/features/chat/chat-input-key.js";

describe("chat input keyboard handling", () => {
  it("does not submit Enter while an IME composition is active", () => {
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
        keyCode: 13,
      }),
    ).toBe(false);
  });

  it("does not submit the IME confirmation key reported with keyCode 229", () => {
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 229,
      }),
    ).toBe(false);
  });

  it("submits a regular Enter but not Shift+Enter", () => {
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(true);
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(false);
  });
});
