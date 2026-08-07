// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetDialogsForTest, ConfirmHost, prompt } from "../src/shared/confirm/confirm.js";

let container: HTMLDivElement;
let root: Root;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  __resetDialogsForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ConfirmHost />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetDialogsForTest();
});

describe("prompt dialog contract", () => {
  it("resolves the entered value when confirmed", async () => {
    let result: Promise<string | null>;
    act(() => {
      result = prompt({ message: "Rename", defaultValue: "old" });
    });

    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("old");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "new name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      (document.querySelector('[data-testid="confirm-accept"]') as HTMLButtonElement).click(),
    );

    await expect(result!).resolves.toBe("new name");
  });

  it("resolves null when cancelled", async () => {
    let result: Promise<string | null>;
    act(() => {
      result = prompt({ message: "Rename", defaultValue: "old" });
    });
    act(() =>
      (document.querySelector('[data-testid="confirm-cancel"]') as HTMLButtonElement).click(),
    );

    await expect(result!).resolves.toBeNull();
  });
});
