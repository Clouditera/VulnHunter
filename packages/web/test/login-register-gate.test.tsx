// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 注册入口按版本收窄：仅 SaaS 开放自助注册（企业版由管理员建号）。
let mockStatus: Record<string, unknown> | undefined;
vi.mock("../src/features/auth/hooks/useSystemStatus.js", () => ({
  useSystemStatus: () => ({ data: mockStatus, isLoading: false, error: null }),
}));

import { LoginPage } from "../src/features/auth/pages/LoginPage.js";

let container: HTMLDivElement;
let root: Root;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function statusOf(edition: string) {
  return {
    edition,
    license: { status: "active" },
    has_admin: true,
    is_authenticated: false,
    user: null,
  };
}

function renderLogin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  mockStatus = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("登录页注册入口版本门控", () => {
  it("SaaS：展示注册链接，点击进入注册面板", () => {
    mockStatus = statusOf("saas");
    renderLogin();
    const link = container.querySelector('[data-testid="auth-go-register"]') as HTMLButtonElement;
    expect(link).not.toBeNull();
    act(() => link.click());
    expect(container.querySelector('[data-testid="auth-panel-register"]')).not.toBeNull();
  });

  it("企业版：不展示注册链接，注册面板不可达", () => {
    mockStatus = statusOf("enterprise");
    renderLogin();
    expect(container.querySelector('[data-testid="auth-go-register"]')).toBeNull();
    expect(container.querySelector('[data-testid="auth-panel-login"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="auth-panel-register"]')).toBeNull();
  });

  it("社区版：不展示注册链接（收窄注册入口仅 SaaS）", () => {
    mockStatus = statusOf("community");
    renderLogin();
    expect(container.querySelector('[data-testid="auth-go-register"]')).toBeNull();
  });
});
