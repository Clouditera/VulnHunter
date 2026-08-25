// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { editionFlags } from "../src/shared/hooks/useEdition.js";

describe("editionFlags", () => {
  it("keeps the existing flags unchanged", () => {
    expect(editionFlags("saas")).toMatchObject({
      isSaas: true,
      isEnterpriseOrAbove: true,
      isCommunity: false,
    });
    expect(editionFlags("enterprise")).toMatchObject({
      isSaas: false,
      isEnterpriseOrAbove: true,
      isCommunity: false,
    });
    expect(editionFlags("community")).toMatchObject({
      isSaas: false,
      isEnterpriseOrAbove: false,
      isCommunity: true,
    });
  });

  it("hasMarketingHome: enterprise 私有化部署不展示营销首页，SaaS/社区版保持现状", () => {
    expect(editionFlags("saas").hasMarketingHome).toBe(true);
    expect(editionFlags("community").hasMarketingHome).toBe(true);
    expect(editionFlags("enterprise").hasMarketingHome).toBe(false);
  });
});
import { describe, expect, it } from "vitest";
import { editionFlags } from "../src/shared/hooks/useEdition.js";

/** Community removal (task-abd37c1f ③): dynamic verification is
 * enterprise/saas-only; community keeps marketing home (unchanged). */
describe("editionFlags hasDynamicVerification", () => {
  it("community: no dynamic verification, marketing home stays", () => {
    const f = editionFlags("community");
    expect(f.hasDynamicVerification).toBe(false);
    expect(f.isCommunity).toBe(true);
    expect(f.hasMarketingHome).toBe(true);
  });
  it("enterprise/saas: dynamic verification on", () => {
    expect(editionFlags("enterprise").hasDynamicVerification).toBe(true);
    expect(editionFlags("saas").hasDynamicVerification).toBe(true);
  });
});
