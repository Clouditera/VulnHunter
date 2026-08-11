// @vitest-environment jsdom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomePage } from "../src/features/home/pages/HomePage.js";

let container: HTMLDivElement;
let root: Root;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("home footer ICP registration", () => {
  it("shows the production domain and links the registration number to MIIT", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>,
      ),
    );

    const footer = container.querySelector('[data-testid="home-footer-icp"]');
    const link = footer?.querySelector("a");

    expect(footer?.textContent).toContain("vulnhunter.pro");
    expect(link?.textContent).toBe("京ICP备2022020425号-4");
    expect(link?.getAttribute("href")).toBe("https://beian.miit.gov.cn/");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
