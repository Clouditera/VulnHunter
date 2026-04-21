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
  "tasks.status.running": "running",
  "tasks.status.completed": "completed",
  "tasks.status.failed": "failed",
  "tasks.status.queued": "queued",
  "tasks.status.paused": "paused",
  "tasks.status.cancelled": "cancelled",
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
