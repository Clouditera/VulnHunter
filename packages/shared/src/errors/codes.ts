export const ERROR_CATALOG = {
  // License
  ERR_LICENSE_NOT_ACTIVATED: {
    httpStatus: 402,
    summary: { zh: "许可证未激活", en: "License not activated" },
    detail: { zh: "请先激活系统许可证", en: "Please activate the license first" },
  },
  ERR_LICENSE_EXPIRED: {
    httpStatus: 402,
    summary: { zh: "许可证已过期", en: "License expired" },
    detail: { zh: "请联系供应商获取新授权码", en: "Please contact your vendor for a new license key" },
  },
  ERR_LICENSE_INVALID: {
    httpStatus: 402,
    summary: { zh: "许可证无效", en: "License invalid" },
    detail: { zh: "许可证签名校验失败", en: "License signature verification failed" },
  },
  // Auth
  ERR_AUTH_REQUIRED: {
    httpStatus: 401,
    summary: { zh: "需要登录", en: "Authentication required" },
    detail: { zh: "请先登录", en: "Please log in to continue" },
  },
  ERR_AUTH_INVALID_CREDENTIALS: {
    httpStatus: 401,
    summary: { zh: "账号或密码错误", en: "Invalid credentials" },
    detail: { zh: "请检查账号和密码", en: "Check your email and password" },
  },
  ERR_AUTH_LOCKED: {
    httpStatus: 429,
    summary: { zh: "账号已锁定", en: "Account locked" },
    detail: { zh: "登录失败次数过多，请 15 分钟后再试", en: "Too many failed attempts, try again in 15 minutes" },
  },
  ERR_ADMIN_REQUIRED: {
    httpStatus: 403,
    summary: { zh: "需要管理员权限", en: "Admin required" },
    detail: { zh: "此操作需要管理员权限", en: "This action requires admin privileges" },
  },
  ERR_ADMIN_BUSINESS_FORBIDDEN: {
    httpStatus: 403,
    summary: { zh: "管理员账号仅用于后台管理", en: "Admin accounts are for console only" },
    detail: { zh: "请使用普通账号使用业务功能", en: "Use a regular account for business features" },
  },
  ERR_CREDIT_CODE_ASSIGNED: {
    httpStatus: 409,
    summary: { zh: "积分码已被领取", en: "Credit code already assigned" },
    detail: { zh: "已领取的积分码不可删除", en: "Assigned credit codes cannot be deleted" },
  },
  // Task
  ERR_TASK_NOT_FOUND: {
    httpStatus: 404,
    summary: { zh: "任务不存在", en: "Task not found" },
    detail: { zh: "指定的任务不存在或已删除", en: "The specified task does not exist or has been deleted" },
  },
  ERR_TASK_UPLOAD_TOO_LARGE: {
    httpStatus: 413,
    summary: { zh: "上传文件过大", en: "Upload too large" },
    detail: { zh: "请上传小于上限的文件", en: "File exceeds the configured size limit" },
  },
  ERR_GIT_CLONE_FAILED: {
    httpStatus: 400,
    summary: { zh: "仓库克隆失败", en: "Git clone failed" },
    detail: { zh: "请检查 URL 和访问权限", en: "Check the URL and access token" },
  },
  // Worker
  ERR_WORKER_SPAWN_FAILED: {
    httpStatus: 500,
    summary: { zh: "Worker 启动失败", en: "Worker failed to start" },
    detail: { zh: "Docker 创建容器失败", en: "Docker failed to create the container" },
  },
  // LLM
  ERR_LLM_API_KEY_INVALID: {
    httpStatus: 502,
    summary: { zh: "LLM API Key 无效", en: "LLM API key invalid" },
    detail: { zh: "请在 Settings 中重新配置 API Key", en: "Reconfigure the API key in Settings" },
  },
  ERR_LLM_TIMEOUT: {
    httpStatus: 504,
    summary: { zh: "LLM 响应超时", en: "LLM timeout" },
    detail: { zh: "LLM API 响应超时，请稍后重试", en: "LLM API timed out, please retry" },
  },
  // Generic
  ERR_INTERNAL: {
    httpStatus: 500,
    summary: { zh: "服务内部错误", en: "Internal server error" },
    detail: { zh: "请查看日志或联系支持", en: "Check logs or contact support" },
  },
  ERR_NOT_FOUND: {
    httpStatus: 404,
    summary: { zh: "资源不存在", en: "Not found" },
    detail: { zh: "请求的资源不存在", en: "The requested resource does not exist" },
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;
