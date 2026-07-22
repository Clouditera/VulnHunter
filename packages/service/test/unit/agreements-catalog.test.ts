import { describe, expect, it } from "vitest";
import {
  REGISTER_AGREEMENTS,
  getAgreementHtml,
  listRegisterAgreements,
} from "../../src/features/auth/agreements.js";

describe("register agreements catalog", () => {
  it("ships three required agreements (user + privacy + saas)", () => {
    expect(REGISTER_AGREEMENTS).toHaveLength(3);
    expect(REGISTER_AGREEMENTS.every((a) => a.required_on_register)).toBe(true);
    expect(REGISTER_AGREEMENTS.map((a) => a.id).sort()).toEqual([
      "privacy-policy",
      "saas-service",
      "user-service",
    ]);
    const saas = REGISTER_AGREEMENTS.find((a) => a.id === "saas-service")!;
    expect(saas.version).toBe("1.1");
  });

  it("list includes html_url for all three", () => {
    const list = listRegisterAgreements();
    expect(list).toHaveLength(3);
    expect(list.every((a) => a.html_url.startsWith("/api/auth/agreements/"))).toBe(true);
    expect(list.some((a) => a.id === "saas-service")).toBe(true);
  });

  it("loads HTML bodies for both agreements", () => {
    for (const a of REGISTER_AGREEMENTS) {
      const found = getAgreementHtml(a.id);
      expect(found, a.id).not.toBeNull();
      expect(found!.html).toContain(a.title);
      expect(found!.html.length).toBeGreaterThan(1000);
    }
  });
});
