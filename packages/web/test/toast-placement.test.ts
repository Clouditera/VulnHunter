import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWebSource = (path: string) => readFileSync(resolve(__dirname, "../src", path), "utf8");

function expectCentered(style: string | undefined) {
  expect(style).toBeDefined();
  expect(style).toMatch(/top:\s*["']?50%["']?/);
  expect(style).toMatch(/left:\s*["']50%["']/);
  expect(style).toMatch(/transform:\s*["']translate\(-50%, -50%\)["']/);
  expect(style).not.toMatch(/bottom:/);
  expect(style).not.toMatch(/right:/);
}

describe("web toast placement", () => {
  it("centers global transient notifications in the viewport", () => {
    const src = readWebSource("shared/toast/toast.tsx");
    const hostStyle = src.match(/const TOAST_HOST_STYLE[^=]*=\s*(\{[\s\S]*?\n\});/)?.[1];

    expectCentered(hostStyle);
  });

  it.each([
    [
      "credentials settings",
      "features/settings/components/CredentialsSection.tsx",
      "settings-toast",
    ],
    [
      "CloudRouter promotion",
      "features/settings/components/CloudRouterPromo.tsx",
      "cloudrouter-toast",
    ],
  ])("centers the %s local notification in the viewport", (_name, path, testId) => {
    const src = readWebSource(path);
    const toastStyle = src.match(
      new RegExp(`data-testid=["']${testId}["'][\\s\\S]*?style=\\{\\{([\\s\\S]*?)\\n\\s*\\}\\}`),
    )?.[1];

    expectCentered(toastStyle);
  });
});
