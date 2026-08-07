import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWebSource = (path: string) => readFileSync(resolve(__dirname, "../src", path), "utf8");

describe("application confirmation dialog", () => {
  it("uses a viewport-sized flex overlay to center the dialog", () => {
    const src = readWebSource("shared/confirm/confirm.tsx");
    const overlayStyle = src.match(/CONFIRM_OVERLAY_STYLE[^=]*=\s*(\{[\s\S]*?\n\});/)?.[1];

    expect(overlayStyle).toBeDefined();
    expect(overlayStyle).toMatch(/position:\s*["']fixed["']/);
    expect(overlayStyle).toMatch(/inset:\s*0/);
    expect(overlayStyle).toMatch(/display:\s*["']flex["']/);
    expect(overlayStyle).toMatch(/alignItems:\s*["']center["']/);
    expect(overlayStyle).toMatch(/justifyContent:\s*["']center["']/);
  });

  it("mounts one global host next to the toast host", () => {
    const src = readWebSource("app/providers.tsx");

    expect(src).toMatch(/<ConfirmHost\s*\/>/);
  });

  it("uses the application dialog for the screenshot's delete-chat flow", () => {
    const src = readWebSource("app/layout.tsx");

    expect(src).toMatch(/await confirm\(\{[\s\S]*?danger:\s*true/);
    expect(src).not.toMatch(/window\.confirm/);
  });
});
