// @vitest-environment jsdom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackModal } from "../src/features/feedback/components/FeedbackModal.js";
import { ConfirmHost, __resetDialogsForTest } from "../src/shared/confirm/confirm.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FeedbackModal close contract", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetDialogsForTest();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn();
    act(() =>
      root.render(
        <>
          <FeedbackModal open onClose={onClose} />
          <ConfirmHost />
        </>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetDialogsForTest();
  });

  it("ignores backdrop clicks when the form is clean", () => {
    const backdrop = container.querySelector('[data-testid="feedback-modal"]') as HTMLElement;
    act(() => backdrop.click());

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="feedback-modal"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it("ignores backdrop clicks when the form is dirty but keeps explicit close guarded", async () => {
    const content = container.querySelector(
      '[data-testid="feedback-content"]',
    ) as HTMLTextAreaElement;
    act(() => type(content, "unfinished feedback"));

    const backdrop = container.querySelector('[data-testid="feedback-modal"]') as HTMLElement;
    act(() => backdrop.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();

    const close = container.querySelector('button[aria-label="close"]') as HTMLButtonElement;
    await act(async () => {
      close.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
