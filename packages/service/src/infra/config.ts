/** Service configuration loaded from environment variables */

export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export interface ServiceConfig {
  port: number;
  dataDir: string;
  edition: "community" | "enterprise";
  db: {
    url: string;
  };
  minio: {
    endpoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  docker: {
    socketPath: string;
    workerImage: string;
    evalWorkerImage: string;
    network: string;
    workerServiceUrl: string;
  };
  sandboxPlane: {
    baseUrl: string | null;
    token: string | null;
    timeoutMs: number;
  };
  /** H1: override the worker-facing ssh host when SandboxPlane is not on this host. */
  sandboxSshHostOverride: string | null;
  /** H1 bastion: user@host[:port] for ProxyJump (empty = direct port-mapping mode). */
  sandboxSshBastion: string | null;
  /** Bastion host public key line for StrictHostKeyChecking pin. */
  sandboxSshBastionHostKey: string | null;
  /** Optional OpenSSH private key content authenticating to the bastion. */
  sandboxSshBastionIdentity: string | null;
  log: {
    level: string;
  };
}

export function loadConfig(): ServiceConfig {
  const edition = optionalEnv("EDITION", "community");
  if (edition !== "community" && edition !== "enterprise") {
    throw new Error(`Invalid EDITION: ${edition}`);
  }

  return {
    port: Number(optionalEnv("PORT", "28080")),
    dataDir: optionalEnv("DATA_DIR", "/data/vulnhunter"),
    edition,
    db: {
      url: optionalEnv("DATABASE_URL", "postgresql://vulnhunter:vulnhunter@localhost:25432/vulnhunter"),
    },
    minio: {
      endpoint: optionalEnv("MINIO_ENDPOINT", "localhost"),
      port: Number(optionalEnv("MINIO_PORT", "29000")),
      useSSL: optionalEnv("MINIO_USE_SSL", "false") === "true",
      accessKey: optionalEnv("MINIO_ACCESS_KEY", "minioadmin"),
      secretKey: optionalEnv("MINIO_SECRET_KEY", "minioadmin"),
      bucket: optionalEnv("MINIO_BUCKET", "artifact-store"),
    },
    docker: {
      socketPath: optionalEnv("DOCKER_SOCKET", "/var/run/docker.sock"),
      workerImage: optionalEnv("WORKER_IMAGE", "vulnhunter-worker:latest"),
      evalWorkerImage: optionalEnv("EVAL_WORKER_IMAGE", "vulnhunter-eval-worker:latest"),
      network: optionalEnv("DOCKER_NETWORK", "vulnhunter-internal"),
      workerServiceUrl: optionalEnv("WORKER_SERVICE_URL", "http://service:28080"),
    },
    sandboxPlane: {
      // Unset -> SandboxPlane is not configured; the internal proxy fails closed
      // (empty type list) instead of guessing or falling back to any default.
      baseUrl: process.env.SANDBOXPLANE_BASE_URL || null,
      token: process.env.SANDBOXPLANE_TOKEN || null,
      timeoutMs: Number(optionalEnv("SANDBOXPLANE_TIMEOUT_MS", "5000")),
    },
    // Worker-facing ssh host for sandbox instances. Default: the plane's
    // reported host, with loopback translated to host.docker.internal.
    sandboxSshHostOverride: process.env.SANDBOX_SSH_HOST_OVERRIDE || null,
    sandboxSshBastion: process.env.SANDBOX_SSH_BASTION || null,
    sandboxSshBastionHostKey: process.env.SANDBOX_SSH_BASTION_HOST_KEY || null,
    sandboxSshBastionIdentity: process.env.SANDBOX_SSH_BASTION_IDENTITY || null,
    log: {
      level: optionalEnv("LOG_LEVEL", "info"),
    },
  };
}
