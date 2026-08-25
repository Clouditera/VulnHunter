export { logger } from "./infra/logger.js";
export { getVersionInfo } from "./infra/version.js";
export type { ServiceConfig } from "./infra/config.js";
export { getDb } from "./infra/db/client.js";
export { setLicenseGuard } from "./middleware/license-guard.js";
export { requireAdmin, requireAuth } from "./middleware/auth.js";
export { getInstallationId } from "./features/system/installation.js";
export { setLicenseStatusGetter } from "./features/system/license-status.js";
export type { CoreLicenseStatus } from "./features/system/license-status.js";
export { createUserAccount } from "./features/auth/service.js";
export { listUsers, findUserByEmail, getUserById, updateUser, countAdmins, deleteUser, deleteAllSessionsForUser } from "./features/auth/storage.js";
export { countTasksForUser } from "./features/tasks/storage.js";

export { licenseGuard } from "./middleware/license-guard.js";
export { queryContextFromUser } from "./infra/query-context.js";
export type { QueryContext } from "./infra/query-context.js";
export { getDefaultCredential, listCredentials, getCredentialById, getSystemConfig, getVaultOptional } from "./features/settings/storage.js";

// ── Sandbox migration exports (community removal ②, task-8a290a7d) ──
// The physically migrated sandbox modules (private packages/enterprise/src/
// sandbox/) import these core internals through this surface only.
export { getMinio } from "./infra/minio/client.js";
export { getSchedulerClaim, mergeTaskMetadata, getTaskById } from "./features/tasks/storage.js";
export type { DbTask } from "./features/tasks/storage.js";
export { isDynamicEnabled } from "./features/prepare/contract.js";
export { taskBearerAuth, getInternalTask } from "./features/internal/task-bearer-auth.js";
export { scanInputEnvFromMeta } from "./features/workers/scan-worker.js";
export { setDynamicProvider, type DynamicVerificationProvider, type DynamicSandboxMapping, DynamicAllocationError } from "./features/dynamic/provider.js";
export { getDocker, LABEL_TASK_ID, LABEL_TASK_TYPE, LABEL_SCHEDULER_CLAIM } from "./features/workers/docker-client.js";
