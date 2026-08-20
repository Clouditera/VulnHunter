/*
 * Version changelog shown in the login popup and the global changelog drawer.
 *
 * To publish a new changelog on release: prepend a CHANGELOG_ENTRIES item.
 * "Seen" state is tracked in localStorage under CHANGELOG_STORAGE_KEY, keyed
 * by the latest changelog version, so each version's popup shows at most once
 * per browser.
 */

export interface ChangelogEntry {
  version: string;
  releasedAt?: string;
  title?: string;
  markdown: string;
}

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    version: "2.3.11",
    releasedAt: "2026-08",
    title: "VulnHunter v2.3.11 更新",
    markdown: `
### 🚀 稳定性
- **暂停/续跑根治**：任务暂停后继续不再触发引擎检查点回放死循环，容器不在时统一走全新续跑（继续扫描），可正常收尾出报告
- **初始化门禁加固**：门禁文件写入即刻校验，坏格式当场打回重写；平台侧宽容兜底，路由判定不再被格式问题误杀
- **初始化预处理技能激活**：jar/war 反编译等 9 个预处理/知识库技能此前未被引擎真正加载，现已全部生效
- **失败原因可读**：引擎报错清洗去乱码（结构化展示）

### 🔒 许可与硬件绑定
- **硬件绑定机器码**：全新实例的许可证与宿主硬件指纹绑定（升级不影响已激活许可证）；克隆/恢复实例到其他机器保持原机器码

### 🔧 其它调整
- 凭证「输出上限（maxTokens）」一等配置（默认 128k），上下文窗口默认 200k；思考级别对所有模型可选（新模型不再被误判不支持）
- 任务时间线开头不再重复投送、收尾事件不再双写
- 安装脚本新增 Docker/Compose 版本预检（需 Docker ≥20.10 与 Compose v2）；安装/升级/出包全链提速（出包 9.9→4.5 分钟、安装镜像加载并行化）
`,
  },
  {
    version: "2.3.0",
    releasedAt: "2026-07",
    title: "VulnHunter v2.3.0 更新",
    markdown: `
### 🛡️ 动态验证
- **优化「POC/EXP」功能**：支持 Web 服务、Linux 应用程序、库、内核等常见项目类型
- **新增「动态利用」**：自动根据已有漏洞发现，构造更复杂的组合漏洞利用
- **漏洞详情页调整**：更清晰地展示漏洞分析状态、漏洞报告、POC/EXP 结果等相关数据

### 🔧 其它调整
- 任务创建功能优化
- Chat 助手优化
- 修复多个已知问题
`.trim(),
  },
  {
    version: "2.2.1",
    releasedAt: "2026-07",
    title: "VulnHunter v2.2.1 更新",
    markdown: `
### 📝 问题修复
修复报告生成功能内容缺失的问题。

### 🚀 体验优化
优化任务详情展示、代码预览、Chat 附件交互等功能。
`.trim(),
  },
  {
    version: "2.2.0",
    releasedAt: "2026-06",
    title: "VulnHunter v2.2.0 更新",
    markdown: `
### 🔍 更精准的漏洞发现
- 扫描结果分为**漏洞**和**风险**两类，帮你区分处理优先级
- 每个发现提供 **CVSS 评分**和**攻击价值评估（EV）**，快速判断哪些最需要关注

### 🎯 可定制的扫描策略
- 创建任务时可以描述你的**审计关注面**，例如"聚焦认证和权限逻辑"
- 自由设置**扫描时长**，小型项目 2-6 小时，大型项目可设 12 小时以上深度审计
- 任务完成后支持**继续深入扫描**，已有发现全部保留，在此基础上发现更多问题

### 📚 知识库
- 扫描过程中自动生成项目各模块的**安全分析笔记**
- 在 Wiki 页面按模块浏览，支持文档间跳转

### 📊 项目画像
- 自动识别项目**语言分布、代码量、技术栈和依赖**，任务详情页直接查看

### 🤖 AI 助手升级
- 通过对话即可**创建任务、查看结果、继续扫描、生成报告**
- 能区分漏洞和风险，用通俗语言解释安全发现
`.trim(),
  },
];

export const LATEST_CHANGELOG_ENTRY = CHANGELOG_ENTRIES[0];
export const CURRENT_CHANGELOG_VERSION = LATEST_CHANGELOG_ENTRY?.version ?? "unknown";
// Compatibility exports for the login modal and any legacy imports.
export const CURRENT_VERSION = CURRENT_CHANGELOG_VERSION;
export const CHANGELOG_MARKDOWN = LATEST_CHANGELOG_ENTRY?.markdown ?? "";
export const CHANGELOG_STORAGE_KEY = "vulnhunter_lastSeenVersion";

export function getChangelogEntry(version?: string): ChangelogEntry | undefined {
  if (!version) return undefined;
  return CHANGELOG_ENTRIES.find((entry) => entry.version === version || `v${entry.version}` === version);
}

export function shouldShowChangelog(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CHANGELOG_STORAGE_KEY) !== CURRENT_CHANGELOG_VERSION;
  } catch {
    return false;
  }
}

export function markChangelogSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHANGELOG_STORAGE_KEY, CURRENT_CHANGELOG_VERSION);
  } catch {
    // localStorage unavailable (private mode / disabled) — silently ignore.
  }
}
