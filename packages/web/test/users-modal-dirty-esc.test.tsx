// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { UsersSection } from "../src/features/settings/components/UsersSection.js";
import { ConfirmHost, __resetDialogsForTest } from "../src/shared/confirm/confirm.js";

/**
 * fish 2026-08-09 ESC saga regression pin: dirty ESC in a real 9999-series
 * form modal (UsersSection CreateUserModal) must surface the unsaved-changes
 * confirm — via REAL keyboard-style bubbling keydown AND in capture phase.
 * (QA probe matrix: bubble ESC died in the admin console; capture fixed it.)
 */

vi.mock("../src/shared/api/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/shared/api/client.js")>();
  return {
    ...mod,
    api: {
      ...mod.api,
      users: {
        list: vi.fn().mockResolvedValue({ users: [] }),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    },
  };
});

function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openDirtyCreateModal(container: HTMLElement) {
  const addBtn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.includes("创建用户") || b.textContent?.includes("Create"),
  )!;
  expect(addBtn).toBeTruthy();
  await act(async () => {
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
  expect(emailInput).toBeTruthy();
  await act(async () => {
    type(emailInput, "dirty@test.local");
  });
}

describe("UsersSection dirty-ESC unsaved confirm (fish 2026-08-09 ESC saga)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  beforeEach(() => {
    __resetDialogsForTest();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("clean ESC closes immediately; dirty bubbling ESC opens the confirm; confirm ESC cancels it", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <UsersSection />
          <ConfirmHost />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // ① clean ESC → closes straight away
    await openDirtyCreateModal(container);
    // clear the field back to clean… simpler: open modal, type nothing — instead
    // close this one cleanly and re-open for the dirty path
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    await act(async () => {
      type(emailInput, "");
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('input[type="email"]')).toBeNull(); // closed
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();

    // ② dirty bubbling ESC → confirm opens (this is the fish case)
    await openDirtyCreateModal(container);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    const dlg = document.querySelector('[data-testid="confirm-dialog"]');
    expect(dlg).not.toBeNull();
    expect(container.querySelector('input[type="email"]')).not.toBeNull(); // modal still open

    // ③ confirm dialog's own ESC cancels it (keep editing), modal content intact
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    const stillThere = container.querySelector('input[type="email"]') as HTMLInputElement | null;
    expect(stillThere).not.toBeNull();
    expect(stillThere?.value).toBe("dirty@test.local");
  });
});
