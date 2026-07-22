import { describe, expect, it } from "vitest";
import {
  REGISTER_AGREEMENTS,
  getAgreementHtml,
  listRegisterAgreements,
} from "../../src/features/auth/agreements.js";

describe("register agreements catalog", () => {
  it("ships two required private-deploy agreements at v1.0", () => {
    expect(REGISTER_AGREEMENTS).toHaveLength(2);
    expect(REGISTER_AGREEMENTS.every((a) => a.required_on_register && a.version === "1.0")).toBe(true);
    expect(REGISTER_AGREEMENTS.map((a) => a.id).sort()).toEqual(["privacy-policy", "user-service"]);
  });

  it("list includes html_url and omits saas agreement", () => {
    const list = listRegisterAgreements();
    expect(list.every((a) => a.html_url.startsWith("/api/auth/agreements/"))).toBe(true);
    expect(list.some((a) => /saas/i.test(a.id) || /saas/i.test(a.title))).toBe(false);
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
