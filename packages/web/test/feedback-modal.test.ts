import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../src/features/feedback/components/FeedbackModal.tsx"),
  "utf8",
);

describe("FeedbackModal close behavior", () => {
  it("only requests closure from the close button", () => {
    expect(source).toMatch(/<div data-testid="feedback-modal"[^>]*style=\{OVERLAY\}>/);
    expect(source).toMatch(
      /<button type="button" onClick=\{requestClose\}[^>]*aria-label="close">/,
    );
    expect(source).toContain("useConfirmClose(onClose, isDirty)");
  });
});
