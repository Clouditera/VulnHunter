/**
 * Lightweight i18n — vanilla JS approach, no external library.
 * Key naming: nav.dashboard, tasks.status.running, etc.
 */

const ZH: Record<string, string> = {
  "nav.dashboard": "仪表板",
  "nav.tasks": "任务",
  "nav.chat": "对话",
  "nav.settings": "设置",
  "nav.logout": "退出",
  "nav.lang": "中文",
  "nav.theme.light": "浅色",
  "nav.theme.dark": "深色",
  "tasks.title": "任务",
  "tasks.newTask": "+ 新建任务",
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
  "tasks.empty": "暂无任务，点击 \"新建任务\" 开始。",
  "tasks.cancel": "取消",
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
  "login.title": "登录",
  "login.email": "邮箱",
  "login.password": "密码",
  "login.submit": "登录",
  "login.signing": "登录中…",
  "activate.title": "激活 VulnHunt",
  "activate.desc": "请输入授权码以激活平台",
  "activate.licenseKey": "授权码",
  "activate.submit": "激活",
  "activate.activating": "激活中…",
  "activate.success": "✅ 激活成功 — 跳转中…",
  "settings.title": "设置",
};

const EN: Record<string, string> = {
  "nav.dashboard": "Dashboard",
  "nav.tasks": "Tasks",
  "nav.chat": "Chat",
  "nav.settings": "Settings",
  "nav.logout": "Sign out",
  "nav.lang": "English",
  "nav.theme.light": "Light",
  "nav.theme.dark": "Dark",
  "tasks.title": "Tasks",
  "tasks.newTask": "+ New Task",
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
  "tasks.empty": "No tasks yet. Click \"+ New Task\" to get started.",
  "tasks.cancel": "Cancel",
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
  "login.title": "VulnHunt",
  "login.email": "Email",
  "login.password": "Password",
  "login.submit": "Sign In",
  "login.signing": "Signing in…",
  "activate.title": "Activate VulnHunt",
  "activate.desc": "Enter your license key to activate the platform",
  "activate.licenseKey": "License Key",
  "activate.submit": "Activate",
  "activate.activating": "Activating…",
  "activate.success": "✅ Activated successfully — redirecting…",
  "settings.title": "Settings",
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
