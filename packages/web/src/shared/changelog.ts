/**
 * Version changelog shown to users in a login popup.
 *
 * To publish a new changelog on release: bump CURRENT_VERSION and replace
 * CHANGELOG_MARKDOWN with the new announcement (Markdown, without the title
 * line — the modal renders the title from CURRENT_VERSION).
 *
 * "Seen" state is tracked in localStorage under CHANGELOG_STORAGE_KEY, keyed
 * by version, so each version's popup shows at most once per browser.
 */

export const CURRENT_VERSION = "2.2.0";

export const CHANGELOG_STORAGE_KEY = "vulnagent_lastSeenVersion";

export const CHANGELOG_MARKDOWN = `
### 🔥 全新扫描引擎

本次更新将扫描引擎进行了全面升级，显著提升漏洞发现的深度和准确性。

AI Agent 像安全专家一样工作——先侦查目标、形成攻击假设、正反两面论证验证，确认后才报告漏洞。这种方式比传统的线性扫描能发现更深层的安全问题。

### ✨ 新功能

**🔍 更精准的漏洞发现**
- **漏洞 + 风险双分类**：扫描结果分为「漏洞」（已确认可利用）和「风险」（潜在隐患），帮助你区分优先级
- **CVSS + EV 双评分**：每个发现同时提供 CVSS 标准评分和 EV 攻击者视角价值评估，更全面地衡量安全影响
- **项目画像**：自动识别项目语言分布、代码量、技术栈和主要依赖

**🎯 可定制的扫描策略**
- **审计关注面**：创建任务时可以用自然语言描述你关注的代码部分，例如"聚焦认证和权限校验逻辑"
- **扫描时长控制**：根据项目规模灵活设置扫描时长（小型项目 30-60 分钟，大型项目 8-24 小时）
- **继续深入扫描**：任务完成后可以一键「继续扫描」，在已有发现的基础上进一步深入探索

**📚 知识库（Wiki）**
- 扫描过程中自动构建项目安全知识库
- 按模块组织的深度分析文档，支持内链跳转浏览
- 知识随扫描持续更新积累

**🤖 AI 助手升级**
- 对话更自然，像安全顾问一样引导你完成操作
- 支持通过对话创建任务、查看结果、继续扫描、生成报告
- 能区分漏洞和风险，用通俗语言解释安全发现

**👥 多用户支持**
- 多用户数据完全隔离，每个用户只能看到自己的数据
- 管理员可设置每用户任务创建限额
- 支持全局凭证和个人凭证分层管理

### 💡 使用建议

1. 创建任务时，在「审计关注面」描述你最关心的安全问题方向
2. 首次扫描根据项目大小设置合理时长，查看初步发现
3. 对感兴趣的结果，使用「继续扫描」让 AI 进一步深入分析
4. 在 Wiki 页面查看 AI 对项目各模块的安全分析笔记
`.trim();

export function shouldShowChangelog(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CHANGELOG_STORAGE_KEY) !== CURRENT_VERSION;
  } catch {
    return false;
  }
}

export function markChangelogSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHANGELOG_STORAGE_KEY, CURRENT_VERSION);
  } catch {
    // localStorage unavailable (private mode / disabled) — silently ignore.
  }
}
