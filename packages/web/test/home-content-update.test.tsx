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

function renderHome() {
  act(() =>
    root.render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    ),
  );
}

describe("home CTA copy", () => {
  it("CTA 副标题展示 www.vulnhunter.pro 域名", () => {
    renderHome();
    expect(container.textContent).toContain("登录 www.vulnhunter.pro，开启你的第一次 AI 安全审计");
    expect(container.textContent).not.toContain("vulnhunter.cn");
  });
});

describe("home footer 公司列外链", () => {
  it("关于我们 → https://www.clouditera.com（新标签 + noopener noreferrer）", () => {
    renderHome();
    const link = [...container.querySelectorAll("footer a")].find(
      (a) => a.textContent === "关于我们",
    );
    expect(link?.getAttribute("href")).toBe("https://www.clouditera.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("联系销售 → https://www.clouditera.com/aboutUs.html?type=3", () => {
    renderHome();
    const link = [...container.querySelectorAll("footer a")].find(
      (a) => a.textContent === "联系销售",
    );
    expect(link?.getAttribute("href")).toBe("https://www.clouditera.com/aboutUs.html?type=3");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("意见反馈 → https://vulnhunter.pro/login", () => {
    renderHome();
    const link = [...container.querySelectorAll("footer a")].find(
      (a) => a.textContent === "意见反馈",
    );
    expect(link?.getAttribute("href")).toBe("https://vulnhunter.pro/login");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("home caps section 12 → 6", () => {
  it("区块标题为「6 大类漏洞能力 · 覆盖代码安全全生命周期」", () => {
    renderHome();
    expect(container.textContent).toContain("6 大类漏洞能力 · 覆盖代码安全全生命周期");
  });

  const EXPECTED_CAPS: Array<[string, string]> = [
    [
      "业务逻辑漏洞",
      "水平/垂直越权（IDOR）、条件竞争、业务状态机绕过、优惠券/余额并发滥用、注册/登录逻辑缺陷等",
    ],
    ["注入类漏洞", "代码/命令注入、跨站脚本、服务端攻击、协议/查询注入、数据解析漏洞等"],
    ["文件与路径类漏洞", "路径遍历、危险文件上传、文件解压漏洞、任意文件读取、临时文件竞态等"],
    [
      "认证与访问控制漏洞",
      "认证机制绕过、会话固定/劫持、CSRF缺陷、沙箱逃逸、开放重定向、OAuth/SSO 流程漏洞等",
    ],
    ["内存安全类漏洞", "缓冲区溢出、竞态条件、整数溢出、函数级缺陷、内存泄漏、空指针解引用等"],
    [
      "信息泄露与密码学漏洞",
      "敏感信息暴露、密钥/凭据硬编码、弱加密算法、密码明文存储/传输、随机数不安全等",
    ],
  ];

  it.each(EXPECTED_CAPS)("能力卡片「%s」文案与 issue 一致", (title, desc) => {
    renderHome();
    const card = [...container.querySelectorAll("#caps [style*='border-radius: 12px']")].find(
      (el) => el.textContent?.includes(title),
    );
    expect(card).toBeDefined();
    expect(card?.textContent).toContain(desc);
  });

  it("caps 区块恰好 6 张卡片，旧的 12 项能力不再出现", () => {
    renderHome();
    const capsSection = container.querySelector("#caps");
    expect(capsSection).not.toBeNull();
    // 6 张能力卡片（不含区块标题/副标题所在的容器本身）
    const cards = capsSection?.querySelectorAll('[style*="border-radius: 12px"]');
    expect(cards?.length).toBe(6);
    const titles = [...(capsSection?.querySelectorAll('[style*="border-radius: 12px"]') ?? [])].map(
      (el) => el.querySelector("div:nth-child(2)")?.textContent,
    );
    for (const gone of [
      "Git 仓库接入",
      "压缩包上传",
      "反序列化",
      "供应链安全",
      "POC/EXP 沙箱",
      "合规审计",
      "认证与权限",
      "XSS / CSRF",
      "文件上传",
      "敏感信息",
    ]) {
      expect(titles).not.toContain(gone);
    }
  });
});
