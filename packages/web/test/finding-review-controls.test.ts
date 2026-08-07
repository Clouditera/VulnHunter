import { describe, expect, it } from "vitest";
import { resolveReviewPickAction } from "../src/features/tasks/components/review-pick-action.js";
import { EN } from "../src/shared/i18n/en.js";
import { ZH } from "../src/shared/i18n/zh.js";

describe("review status selection", () => {
  it("requires confirmation before marking a finding as confirmed", () => {
    expect(resolveReviewPickAction("pending", "confirmed")).toBe("confirm");
  });

  it("does nothing when the current conclusion is picked", () => {
    expect(resolveReviewPickAction("confirmed", "confirmed")).toBe("noop");
  });

  it.each(["pending", "confirmed", "false_positive", "ignored"] as const)(
    "requires confirmation before changing the conclusion to %s",
    (next) => {
      const current = next === "pending" ? "confirmed" : "pending";
      expect(resolveReviewPickAction(current, next)).toBe("confirm");
    },
  );

  it("uses dedicated confirmation copy without changing the shared confirm label", () => {
    expect(ZH["review.section.title"]).toBe("审核结论");
    expect(ZH["review.note.confirmMark"]).toBe("确认标记");
    expect(ZH["review.action.confirm"]).toBe("确认");
    expect(EN["review.section.title"]).toBe("Review Conclusion");
    expect(EN["review.note.confirmMark"]).toBe("Confirm Mark");
    expect(EN["review.action.confirm"]).toBe("Confirm");
  });
});
