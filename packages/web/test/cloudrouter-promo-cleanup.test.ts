import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWebSource = (path: string) => readFileSync(resolve(__dirname, "../src", path), "utf8");

/**
 * HALL-21: 送积分活动取消 — CloudRouter 推广块清理。
 * 以下断言锁定被删文案不再回归：
 * - `settings.creds.cloudRouter.sub` / `.exhausted` 渲染与 i18n key 全部移除；
 * - `onboarding.step1BodySaas` 不再承诺"免费领取积分码"。
 */
describe("CloudRouter promo cleanup (HALL-21)", () => {
  const promoSrc = readWebSource("features/settings/components/CloudRouterPromo.tsx");
  const zhSrc = readWebSource("shared/i18n/zh.ts");
  const enSrc = readWebSource("shared/i18n/en.ts");

  it("no longer renders the free-credit-code subtitle", () => {
    expect(promoSrc).not.toMatch(/cloudRouter\.sub/);
    expect(promoSrc).not.toContain("免费领取体验积分码");
  });

  it("no longer renders the pool-empty dashed notice", () => {
    expect(promoSrc).not.toMatch(/cloudRouter\.exhausted/);
    expect(promoSrc).not.toContain("cloudrouter-pool-empty");
  });

  it("keeps the claim button and claimed panel intact", () => {
    // 积分码领取入口与已领取面板（用户已领的码仍可见可复制）保持不动
    expect(promoSrc).toContain("cloudrouter-claim-btn");
    expect(promoSrc).toContain("cloudrouter-claimed");
    expect(promoSrc).toContain("cloudrouter-copy-btn");
    expect(promoSrc).toContain("settings.creds.cloudRouter.claimedGuideBefore");
  });

  it("vertically centers the go button in the right column", () => {
    // 外层 shell 垂直居中（alignItems center）+ 右侧栏容器列内居中（justifyContent center），
    // 三态（可领取/池空/已领取）下右侧栏均与左侧文案块垂直居中对齐
    const shellStyle = promoSrc.match(/const shell: CSSProperties = \{([\s\S]*?)\};/)?.[1];
    expect(shellStyle).toBeDefined();
    expect(shellStyle).toMatch(/alignItems:\s*"center"/);
    const rightColumn = promoSrc.match(
      /flexShrink:\s*0,\s*minWidth:\s*160,[\s\S]*?textAlign:\s*"center",\s*\}\}/,
    )?.[0];
    expect(rightColumn).toBeDefined();
    expect(rightColumn).toMatch(/justifyContent:\s*"center"/);
    expect(rightColumn).toMatch(/textAlign:\s*"center"/);
  });

  it("removes the dropped i18n keys in both locales", () => {
    for (const src of [zhSrc, enSrc]) {
      expect(src).not.toMatch(/settings\.creds\.cloudRouter\.sub/);
      expect(src).not.toMatch(/settings\.creds\.cloudRouter\.exhausted/);
    }
  });

  it("keeps the poolEmpty branch rendering only the go button", () => {
    const poolEmptyBranch = promoSrc.match(/poolEmpty\s*\?[\s\S]*?:\s*\(/)?.[0];
    expect(poolEmptyBranch).toBeDefined();
    // 分支内不应再渲染 GoButton 之外的内容（无 pool-empty 提示框、无领取按钮）
    expect(promoSrc).toMatch(/poolEmpty\s*\?\s*\(\s*<GoButton\s*\/>\s*\)\s*:/);
  });

  it("onboarding copy no longer promises free credit codes", () => {
    const zhLine = zhSrc.match(/"onboarding\.step1BodySaas":\s*"([^"]*)"/)?.[1] ?? "";
    const enLine = enSrc.match(/"onboarding\.step1BodySaas":\s*"([^"]*)"/)?.[1] ?? "";
    // 不再出现"免费领取积分码"承诺（中英文）
    expect(zhLine).not.toContain("免费领取");
    expect(zhLine).not.toContain("积分码");
    expect(enLine.toLowerCase()).not.toContain("free");
    expect(enLine.toLowerCase()).not.toContain("trial code");
    // 仍引导注册 CloudRouter
    expect(zhLine).toContain("CloudRouter");
    expect(enLine).toContain("CloudRouter");
  });
});
