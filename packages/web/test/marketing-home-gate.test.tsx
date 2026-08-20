// @vitest-environment jsdom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the status endpoint hook — guards derive edition from it.
let mockStatus: Record<string, unknown> | undefined;
let mockLoading = false;
vi.mock("../src/features/auth/hooks/useSystemStatus.js", () => ({
  useSystemStatus: () => ({ data: mockStatus, isLoading: mockLoading, error: null }),
}));

import { HomeGate, RootGuard } from "../src/app/router.js";

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

function render(initialPath: string, element: React.ReactElement) {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path={initialPath} element={element} />
          <Route path="/login" element={<div data-testid="login-marker" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

beforeEach(() => {
  mockStatus = undefined;
  mockLoading = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RootGuard marketing-home gating", () => {
  it("企业版未认证访问 / 重定向到登录页，不渲染营销首页", () => {
    mockStatus = statusOf("enterprise");
    render("/", <RootGuard />);
    expect(container.querySelector('[data-testid="login-marker"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home-page"]')).toBeNull();
  });

  it("SaaS 未认证访问 / 仍渲染营销首页", () => {
    mockStatus = statusOf("saas");
    render("/", <RootGuard />);
    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="login-marker"]')).toBeNull();
  });

  it("社区版未认证访问 / 行为不变（仍渲染营销首页）", () => {
    mockStatus = statusOf("community");
    render("/", <RootGuard />);
    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull();
  });

  it("status 请求失败时兜底仍渲染营销首页（已知折中：此时无法得知版本）", () => {
    mockStatus = undefined;
    render("/", <RootGuard />);
    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull();
  });
});

describe("HomeGate (/home 直链门控)", () => {
  it("企业版访问 /home 重定向到登录页", () => {
    mockStatus = statusOf("enterprise");
    render("/home", <HomeGate />);
    expect(container.querySelector('[data-testid="login-marker"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home-page"]')).toBeNull();
  });

  it("SaaS 访问 /home 正常渲染营销首页", () => {
    mockStatus = statusOf("saas");
    render("/home", <HomeGate />);
    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull();
  });
});
