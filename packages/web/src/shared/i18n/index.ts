/**
 * Lightweight i18n — vanilla JS approach, no external library.
 * Key naming: nav.dashboard, tasks.status.running, etc.
 */

const ZH: Record<string, string> = {
  // Nav
  "nav.dashboard": "仪表板",
  "nav.tasks": "任务",
  "nav.chat": "对话",
  "nav.settings": "设置",
  "nav.logout": "退出",
  "nav.lang": "中文",
  "nav.theme.light": "浅色",
  "nav.theme.dark": "深色",

  // Tasks
  "tasks.title": "任务",
  "tasks.newTask": "新建任务",
  "tasks.status.running": "运行中",
  "tasks.status.completed": "已完成",
  "tasks.status.failed": "失败",
  "tasks.status.queued": "队列中",
  "tasks.status.paused": "已暂停",
  "tasks.status.cancelled": "已取消",
  "tasks.col.project": "项目",
  "tasks.col.status": "状态",
  "tasks.col.riskScore": "风险评分",
  "tasks.col.duration": "耗时",
  "tasks.col.created": "创建时间",
  "tasks.col.actions": "操作",
  "tasks.col.findings": "漏洞",
  "tasks.col.time": "时间",
  "dashboard.subtitle": "安全审计总览与统计",
  "tasks.empty": "暂无任务，点击「新建任务」开始。",
  "tasks.cancel": "取消",
  "tasks.delete": "删除",
  "tasks.delete.confirm": "确认删除任务“{name}”？此操作不可撤销，该任务的所有漏洞、报告和工作区都将被移除。",
  "tasks.delete.error": "删除失败",
  "tasks.findings.scanning": "扫描中…",
  "tasks.findings.none": "无漏洞",
  "tasks.loading": "加载中…",
  "tasks.sourceGit": "Git",
  "tasks.sourceUpload": "上传",
  "tasks.filterAll": "全部",

  // Task Detail
  "taskDetail.tab.overview": "概览",
  "taskDetail.tab.findings": "漏洞",
  "taskDetail.tab.reports": "报告",
  "taskDetail.tab.poc": "POC/EXP",
  "taskDetail.tab.workspace": "工作区",
  "taskDetail.loading": "加载中…",
  "taskDetail.notFound": "任务未找到",
  "taskDetail.back": "返回任务列表",
  "taskDetail.cancel": "取消任务",
  "taskDetail.restart": "重新扫描",
  "taskDetail.failure.title": "扫描失败",
  "taskDetail.failure.noReason": "未提供失败原因。查看日志获取详细信息。",
  "taskDetail.failure.viewLog": "查看完整日志",
  "taskDetail.failure.retry": "重新尝试",
  "taskDetail.meta.risk": "风险",
  "taskDetail.meta.duration": "耗时",
  "taskDetail.meta.started": "开始于",
  "overview.project": "项目",
  "overview.language": "语言",
  "overview.buildSystem": "构建系统",
  "overview.files": "文件数",
  "overview.loc": "代码行数",
  "overview.description": "描述",
  "overview.source": "来源",
  "overview.sourceGit": "Git 仓库",
  "overview.sourceUpload": "上传压缩包",
  "overview.status": "状态",
  "overview.created": "创建于",
  "overview.overallRiskScore": "综合风险评分",
  "overview.riskNotAvailable": "暂无评分",
  "overview.analyzing": "分析中…",
  "overview.keyFindings": "关键漏洞",
  "overview.keyFindingsCount": "共 {n} 条",
  "overview.noFindings": "未发现漏洞",
  "overview.scanInProgress": "扫描进行中…",
  "overview.duration": "耗时",
  "overview.model": "模型",
  "overview.concurrency": "并发度",
  "overview.tokenUsage": "Token 用量",
  "overview.toolCalls": "工具调用",

  // Overview
  "overview.projectProfile": "工程画像",
  "overview.riskAssessment": "风险评估",
  "overview.executionSummary": "执行摘要",
  "overview.riskScore": "风险评分",
  "overview.totalFindings": "总漏洞数",
  "overview.tokens": "Token 用量",
  "overview.stages": "阶段数",

  // Findings
  "findings.filterAll": "全部",
  "findings.sevHigh": "高危",
  "findings.sevMedium": "中危",
  "findings.sevLow": "低危",
  "findings.sevInfo": "信息",
  "findings.count": "个漏洞",
  "findings.empty": "暂无漏洞。",
  "findings.loading": "加载中…",
  "findings.description": "描述",
  "findings.remediation": "修复建议",
  "findings.selectToView": "选择漏洞查看源代码",

  // Dashboard
  "dashboard.title": "仪表板",
  "dashboard.totalScans": "总扫描数",
  "dashboard.vulnerabilities": "漏洞",
  "dashboard.avgDuration": "平均耗时",
  "dashboard.tokenUsage": "Token 用量",
  "dashboard.perScan": "每次扫描",
  "dashboard.cumulative": "累计",
  "dashboard.severityDist": "严重性分布",
  "dashboard.cweTop5": "CWE Top 5",
  "dashboard.recentScans": "近期扫描",
  "dashboard.noScans": "暂无扫描记录",
  "dashboard.noCwe": "暂无 CWE 数据",
  "dashboard.loading": "加载中…",

  // Login
  "login.title": "登录",
  "login.subtitle": "登录以继续",
  "login.email": "邮箱",
  "login.password": "密码",
  "login.submit": "登录",
  "login.signing": "登录中…",
  "login.errorLocked": "登录尝试次数过多，请 15 分钟后重试。",
  "login.errorInvalid": "邮箱或密码错误。",

  // Activate
  "activate.title": "激活 VulnHunt",
  "activate.desc": "请输入授权码以激活平台",
  "activate.licenseKey": "授权码",
  "activate.placeholder": "粘贴授权证书 JSON",
  "activate.submit": "激活",
  "activate.activating": "激活中…",
  "activate.success": "✅ 激活成功 — 跳转中…",

  // Expired
  "expired.title": "许可证已过期",
  "expired.desc": "您的许可证已过期，请联系供应商获取续期密钥。",
  "expired.renewalKey": "续期密钥",
  "expired.placeholder": "粘贴续期证书 JSON",
  "expired.submit": "续期",
  "expired.renewing": "续期中…",
  "expired.success": "✅ 续期成功 — 跳转中…",
  "expired.error": "续期密钥无效，请联系供应商。",

  // Bootstrap
  "bootstrap.title": "初始化管理员",
  "bootstrap.desc": "创建第一个管理员账户",
  "bootstrap.email": "管理员邮箱",
  "bootstrap.password": "密码",
  "bootstrap.confirm": "确认密码",
  "bootstrap.submit": "创建管理员",
  "bootstrap.creating": "创建中…",

  // Settings
  "settings.title": "设置",
  "settings.subtitle": "配置模型与扫描偏好",
  "settings.loading": "加载中…",
  "settings.saveBtn": "保存设置",
  "settings.saving": "保存中…",
  "settings.savedToast": "✓ 设置已保存",
  "settings.saveError": "保存失败",
  // License
  "settings.license.title": "许可证信息",
  "settings.license.desc": "你的平台激活状态和有效期",
  "settings.license.status": "状态",
  "settings.license.expires": "到期日",
  "settings.license.remaining": "剩余",
  "settings.license.days": "天",
  "settings.license.machineCode": "机器码",
  "settings.license.installId": "安装 ID",
  "settings.license.status.active": "已激活",
  "settings.license.status.expired": "已过期",
  "settings.license.status.not_activated": "未激活",
  "settings.license.status.invalid": "无效",
  // Model Config
  "settings.model.title": "模型配置",
  "settings.model.desc": "接入 LLM 服务以驱动安全分析",
  "settings.model.protocol": "协议",
  "settings.model.model": "模型",
  "settings.model.baseUrl": "BASE URL（可选）",
  "settings.model.baseUrlPlaceholder": "留空使用官方端点",
  "settings.model.apiKey": "API KEY",
  "settings.model.apiKeyPlaceholder": "sk-ant-...",
  "settings.model.apiKeyLocked": "已保存，留空则不更新",
  "settings.model.thinking": "思考深度",
  "settings.model.thinking.hint": "控制模型推理深度",
  "settings.model.fetch": "获取列表",
  "settings.model.fetching": "获取中…",
  "settings.model.fetchError": "无法获取模型列表 — 请手动输入",
  "settings.model.fetchNone": "该端点未返回任何模型",
  "settings.model.test": "测试连接",
  "settings.model.testing": "测试中…",
  "settings.model.testOk": "✓ 连接正常",
  "settings.model.testFail": "✗ 连接失败",
  "settings.model.testNeedsKey": "请先填写 API Key 后再测试",
  "settings.model.thinking.off": "关闭",
  "settings.model.thinking.minimal": "最小",
  "settings.model.thinking.low": "低",
  "settings.model.thinking.medium": "中",
  "settings.model.thinking.high": "高",
  // Appearance
  "settings.appearance.title": "语言与外观",
  "settings.appearance.desc": "界面语言与视觉主题",
  "settings.appearance.langLabel": "语言",
  "settings.appearance.langHint": "仅影响界面文案，日志与漏洞内容保持原语言",
  "settings.appearance.themeLabel": "主题",
  // Engine
  "settings.engine.title": "引擎配置",
  "settings.engine.desc": "调整扫描引擎行为",
  "settings.engine.maxParallel": "最大并发任务数",
  "settings.engine.maxParallel.hint": "同时进行的分析任务数",

  // New Task Modal
  "newTask.title": "新建任务",
  "newTask.tabUpload": "上传 Zip",
  "newTask.tabGit": "Git URL",
  "newTask.projectName": "项目名称",
  "newTask.projectPlaceholder": "如 libpng-1.6.54",
  "newTask.gitUrl": "Git URL",
  "newTask.gitPlaceholder": "https://github.com/org/repo",
  "newTask.branch": "分支（可选）",
  "newTask.dropzone": "拖放或点击选择 .zip 文件",
  "newTask.submit": "开始扫描",
  "newTask.submitting": "创建中…",
  "newTask.cancel": "取消",

  // Chat placeholder
  "chat.title": "AI 助手",
  "chat.placeholder": "AI 助手 — 即将推出",

  // Placeholder tabs
  "placeholder.reports": "报告",
  "placeholder.poc": "POC/EXP",
  "placeholder.workspace": "工作区",
  "placeholder.comingSoon": "即将推出",

  // LiveLog
  "liveLog.noEvents": "暂无事件…",
  "liveLog.events": "个事件",
  "liveLog.waiting": "等待事件…",
  "liveLog.allSources": "全部",

  // Workspace tab
  "workspace.files": "文件",
  "workspace.empty": "该任务没有源码包或包为空",

  // POC tab
  "poc.title": "POC / 利用代码",
  "poc.loading": "加载 POC 文件…",
  "poc.empty": "该扫描未生成 POC / 利用代码文件",
  "poc.loadingFile": "加载文件…",
  "poc.errorFile": "文件加载失败",
  "poc.copy": "复制",
  "poc.copied": "✓ 已复制",
  "poc.download": "下载",
  "poc.bytes": "字节",
  "poc.status.ready": "就绪",
  "workspace.loading.tree": "加载文件树…",
  "workspace.loading.file": "加载文件…",
  "workspace.error.file": "文件加载失败",
  "workspace.select": "从左侧选择文件查看代码",
  "workspace.binary": "二进制文件，不适合预览",
  "workspace.truncated": "文件过大，内容已截断",
  "workspace.lines": "行",
  "workspace.search": "搜索文件…",
  "workspace.vulnsInFile": "{n} 个漏洞",

  // Common
  "common.loading": "加载中…",
  "common.noData": "—",
  "common.min": "分钟",
};

const EN: Record<string, string> = {
  // Nav
  "nav.dashboard": "Dashboard",
  "nav.tasks": "Tasks",
  "nav.chat": "Chat",
  "nav.settings": "Settings",
  "nav.logout": "Sign out",
  "nav.lang": "English",
  "nav.theme.light": "Light",
  "nav.theme.dark": "Dark",

  // Tasks
  "tasks.title": "Tasks",
  "tasks.newTask": "New Task",
  "tasks.status.running": "Running",
  "tasks.status.completed": "Completed",
  "tasks.status.failed": "Failed",
  "tasks.status.queued": "Queued",
  "tasks.status.paused": "Paused",
  "tasks.status.cancelled": "Cancelled",
  "tasks.col.project": "Project",
  "tasks.col.status": "Status",
  "tasks.col.riskScore": "Risk Score",
  "tasks.col.duration": "Duration",
  "tasks.col.created": "Created",
  "tasks.col.actions": "Actions",
  "tasks.col.findings": "Findings",
  "tasks.col.time": "Time",
  "dashboard.subtitle": "Security audit overview",
  "tasks.empty": "No tasks yet. Click \"+ New Task\" to get started.",
  "tasks.cancel": "Cancel",
  "tasks.delete": "Delete",
  "tasks.delete.confirm": "Delete task “{name}”? This cannot be undone — all findings, reports, and workspace data will be removed.",
  "tasks.delete.error": "Delete failed",
  "tasks.findings.scanning": "scanning…",
  "tasks.findings.none": "none",
  "tasks.loading": "Loading…",
  "tasks.sourceGit": "Git",
  "tasks.sourceUpload": "Upload",
  "tasks.filterAll": "all",

  // Task Detail
  "taskDetail.tab.overview": "Overview",
  "taskDetail.tab.findings": "Findings",
  "taskDetail.tab.reports": "Reports",
  "taskDetail.tab.poc": "POC/EXP",
  "taskDetail.tab.workspace": "Workspace",
  "taskDetail.loading": "Loading…",
  "taskDetail.notFound": "Task not found",
  "taskDetail.back": "Back to Tasks",
  "taskDetail.cancel": "Cancel Task",
  "taskDetail.restart": "Restart Scan",
  "taskDetail.failure.title": "Scan Failed",
  "taskDetail.failure.noReason": "No failure reason provided. Check the log for details.",
  "taskDetail.failure.viewLog": "View Full Log",
  "taskDetail.failure.retry": "Retry",
  "taskDetail.meta.risk": "Risk",
  "taskDetail.meta.duration": "Duration",
  "taskDetail.meta.started": "Started",
  "overview.project": "Project",
  "overview.language": "Language",
  "overview.buildSystem": "Build System",
  "overview.files": "Files",
  "overview.loc": "Lines of Code",
  "overview.description": "Description",
  "overview.source": "Source",
  "overview.sourceGit": "Git Repository",
  "overview.sourceUpload": "Uploaded Archive",
  "overview.status": "Status",
  "overview.created": "Created",
  "overview.overallRiskScore": "Overall Risk Score",
  "overview.riskNotAvailable": "Score not available",
  "overview.analyzing": "Analysis in progress…",
  "overview.keyFindingsCount": "{n} total",
  "overview.scanInProgress": "Scan in progress…",
  "overview.duration": "Duration",
  "overview.model": "Model",
  "overview.concurrency": "Concurrency",
  "overview.tokenUsage": "Token Usage",
  "overview.toolCalls": "Tool Calls",

  // Overview
  "overview.projectProfile": "Project Profile",
  "overview.riskAssessment": "Risk Assessment",
  "overview.executionSummary": "Execution Summary",
  "overview.riskScore": "Risk Score",
  "overview.totalFindings": "Total Findings",
  "overview.keyFindings": "Key Findings",
  "overview.tokens": "Tokens",
  "overview.stages": "Stages",

  // Findings
  "findings.filterAll": "all",
  "findings.sevHigh": "High",
  "findings.sevMedium": "Medium",
  "findings.sevLow": "Low",
  "findings.sevInfo": "Info",
  "findings.count": "findings",
  "findings.empty": "No findings.",
  "findings.loading": "Loading…",
  "findings.description": "Description",
  "findings.remediation": "Remediation",
  "findings.selectToView": "Select a finding to view source",

  // Dashboard
  "dashboard.title": "Dashboard",
  "dashboard.totalScans": "Total Scans",
  "dashboard.vulnerabilities": "Vulnerabilities",
  "dashboard.avgDuration": "Avg. Duration",
  "dashboard.tokenUsage": "Token Usage",
  "dashboard.perScan": "per scan",
  "dashboard.cumulative": "cumulative",
  "dashboard.severityDist": "Severity Distribution",
  "dashboard.cweTop5": "CWE Top 5",
  "dashboard.recentScans": "Recent Scans",
  "dashboard.noScans": "No scans yet",
  "dashboard.noCwe": "No CWE data yet",
  "dashboard.loading": "Loading…",

  // Login
  "login.title": "VulnHunt",
  "login.subtitle": "Sign in to continue",
  "login.email": "Email",
  "login.password": "Password",
  "login.submit": "Sign In",
  "login.signing": "Signing in…",
  "login.errorLocked": "Too many failed attempts. Try again in 15 minutes.",
  "login.errorInvalid": "Invalid email or password.",

  // Activate
  "activate.title": "Activate VulnHunt",
  "activate.desc": "Enter your license key to activate the platform",
  "activate.licenseKey": "License Key",
  "activate.placeholder": "Paste your license certificate JSON here",
  "activate.submit": "Activate",
  "activate.activating": "Activating…",
  "activate.success": "✅ Activated successfully — redirecting…",

  // Expired
  "expired.title": "License Expired",
  "expired.desc": "Your license has expired. Please contact your vendor to obtain a renewal key.",
  "expired.renewalKey": "Renewal Key",
  "expired.placeholder": "Paste your renewal license certificate JSON here",
  "expired.submit": "Renew License",
  "expired.renewing": "Renewing…",
  "expired.success": "✅ Renewed successfully — redirecting…",
  "expired.error": "Invalid renewal key. Please contact your vendor.",

  // Bootstrap
  "bootstrap.title": "Initialize Admin",
  "bootstrap.desc": "Create the first administrator account",
  "bootstrap.email": "Admin Email",
  "bootstrap.password": "Password",
  "bootstrap.confirm": "Confirm Password",
  "bootstrap.submit": "Create Admin",
  "bootstrap.creating": "Creating…",

  // Settings
  "settings.title": "Settings",
  "settings.subtitle": "Configure your AI model and scanning preferences",
  "settings.loading": "Loading…",
  "settings.saveBtn": "Save Settings",
  "settings.saving": "Saving…",
  "settings.savedToast": "✓ Settings saved",
  "settings.saveError": "Save failed",
  // License
  "settings.license.title": "License Information",
  "settings.license.desc": "Your platform activation and license status",
  "settings.license.status": "Status",
  "settings.license.expires": "Expires",
  "settings.license.remaining": "Remaining",
  "settings.license.days": "days",
  "settings.license.machineCode": "Machine Code",
  "settings.license.installId": "Installation ID",
  "settings.license.status.active": "Active",
  "settings.license.status.expired": "Expired",
  "settings.license.status.not_activated": "Not Activated",
  "settings.license.status.invalid": "Invalid",
  // Model Config
  "settings.model.title": "Model Configuration",
  "settings.model.desc": "Connect to an LLM provider to power security analysis",
  "settings.model.protocol": "PROTOCOL",
  "settings.model.model": "MODEL",
  "settings.model.baseUrl": "BASE URL (OPTIONAL)",
  "settings.model.baseUrlPlaceholder": "Leave blank for official endpoint",
  "settings.model.apiKey": "API KEY",
  "settings.model.apiKeyPlaceholder": "sk-ant-...",
  "settings.model.apiKeyLocked": "Saved. Leave blank to keep existing.",
  "settings.model.thinking": "THINKING DEPTH",
  "settings.model.thinking.hint": "Controls the depth of model reasoning.",
  "settings.model.fetch": "Fetch list",
  "settings.model.fetching": "Fetching…",
  "settings.model.fetchError": "Could not fetch model list — please type manually.",
  "settings.model.fetchNone": "Endpoint returned no models.",
  "settings.model.test": "Test Connection",
  "settings.model.testing": "Testing…",
  "settings.model.testOk": "✓ Connection OK",
  "settings.model.testFail": "✗ Connection failed",
  "settings.model.testNeedsKey": "Fill in the API key first to test.",
  "settings.model.thinking.off": "off",
  "settings.model.thinking.minimal": "minimal",
  "settings.model.thinking.low": "low",
  "settings.model.thinking.medium": "medium",
  "settings.model.thinking.high": "high",
  // Appearance
  "settings.appearance.title": "Language & Appearance",
  "settings.appearance.desc": "Interface language and visual theme",
  "settings.appearance.langLabel": "LANGUAGE",
  "settings.appearance.langHint": "Affects UI labels only. Logs and findings remain in their original language.",
  "settings.appearance.themeLabel": "THEME",
  // Engine
  "settings.engine.title": "Engine Settings",
  "settings.engine.desc": "Tune the scanning engine behavior",
  "settings.engine.maxParallel": "MAX PARALLEL TASKS",
  "settings.engine.maxParallel.hint": "Number of concurrent analysis tasks.",

  // New Task Modal
  "newTask.title": "New Task",
  "newTask.tabUpload": "Upload Zip",
  "newTask.tabGit": "Git URL",
  "newTask.projectName": "Project Name",
  "newTask.projectPlaceholder": "e.g. libpng-1.6.54",
  "newTask.gitUrl": "Git URL",
  "newTask.gitPlaceholder": "https://github.com/org/repo",
  "newTask.branch": "Branch (optional)",
  "newTask.dropzone": "Drop or click to select .zip file",
  "newTask.submit": "Start Scan",
  "newTask.submitting": "Creating…",
  "newTask.cancel": "Cancel",

  // Chat placeholder
  "chat.title": "AI Assistant",
  "chat.placeholder": "AI assistant — coming soon",

  // Placeholder tabs
  "placeholder.reports": "Reports",
  "placeholder.poc": "POC/EXP",
  "placeholder.workspace": "Workspace",
  "placeholder.comingSoon": "Coming soon",

  // LiveLog
  "liveLog.noEvents": "No events yet…",
  "liveLog.events": "events",
  "liveLog.waiting": "Waiting for events…",
  "liveLog.allSources": "All",

  // Workspace tab
  "workspace.files": "Files",
  "workspace.empty": "No source archive is available for this task.",

  // POC tab
  "poc.title": "POC / Exploits",
  "poc.loading": "Loading POC files…",
  "poc.empty": "No POC or exploit files were generated by this scan.",
  "poc.loadingFile": "Loading file…",
  "poc.errorFile": "Failed to load file",
  "poc.copy": "Copy",
  "poc.copied": "✓ Copied",
  "poc.download": "Download",
  "poc.bytes": "bytes",
  "poc.status.ready": "Ready",
  "workspace.loading.tree": "Loading file tree…",
  "workspace.loading.file": "Loading file…",
  "workspace.error.file": "Failed to load file",
  "workspace.select": "Select a file from the tree to view its source.",
  "workspace.binary": "Binary file — preview is not available.",
  "workspace.truncated": "File is large — content has been truncated.",
  "workspace.lines": "lines",
  "workspace.search": "Search files…",
  "workspace.vulnsInFile": "{n} finding(s)",

  // Common
  "common.loading": "Loading…",
  "common.noData": "—",
  "common.min": "min",
};

const CATALOGS: Record<string, Record<string, string>> = { zh: ZH, en: EN };

const STORAGE_KEY = "vh-lang";

function detectLocale(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return saved;
  return navigator.language.startsWith("zh") ? "zh" : "en";
}

let currentLocale = detectLocale();
const listeners: Array<() => void> = [];

export const i18n = {
  t(key: string): string {
    return CATALOGS[currentLocale]?.[key] ?? CATALOGS.en[key] ?? key;
  },

  locale(): string {
    return currentLocale;
  },

  setLocale(lang: "zh" | "en"): void {
    currentLocale = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    listeners.forEach((fn) => fn());
  },

  toggle(): void {
    i18n.setLocale(currentLocale === "zh" ? "en" : "zh");
  },

  onChange(fn: () => void): () => void {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },
};
