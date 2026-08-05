import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("web toast placement", () => {
  const src = readFileSync(resolve(__dirname, "../src/shared/toast/toast.tsx"), "utf8");

  it("centers transient notifications in the viewport", () => {
    const hostStyle = src.match(/const TOAST_HOST_STYLE[^=]*=\s*(\{[\s\S]*?\n\});/)?.[1];

    expect(hostStyle).toBeDefined();
    expect(hostStyle).toMatch(/top:\s*"50%"/);
    expect(hostStyle).toMatch(/left:\s*"50%"/);
    expect(hostStyle).toMatch(/transform:\s*"translate\(-50%, -50%\)"/);
    expect(hostStyle).not.toMatch(/bottom:/);
    expect(hostStyle).not.toMatch(/right:/);
  });
});
