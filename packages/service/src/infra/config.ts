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
    dataDir: optionalEnv("DATA_DIR", "/data/vulnagent"),
    edition,
    db: {
      url: optionalEnv("DATABASE_URL", "postgresql://vulnagent:vulnagent@localhost:25432/vulnagent"),
    },
    minio: {
      endpoint: optionalEnv("MINIO_ENDPOINT", "localhost"),
      port: Number(optionalEnv("MINIO_PORT", "29000")),
      useSSL: optionalEnv("MINIO_USE_SSL", "false") === "true",
      accessKey: optionalEnv("MINIO_ACCESS_KEY", "minioadmin"),
      secretKey: optionalEnv("MINIO_SECRET_KEY", "minioadmin"),
      bucket: optionalEnv("MINIO_BUCKET", "vulnagent"),
    },
    docker: {
      socketPath: optionalEnv("DOCKER_SOCKET", "/var/run/docker.sock"),
      workerImage: optionalEnv("WORKER_IMAGE", "vulnagent-worker:latest"),
      evalWorkerImage: optionalEnv("EVAL_WORKER_IMAGE", "vulnagent-eval-worker:latest"),
      network: optionalEnv("DOCKER_NETWORK", "vulnagent-internal"),
      workerServiceUrl: optionalEnv("WORKER_SERVICE_URL", "http://service:28080"),
    },
    sandboxPlane: {
      // Unset -> SandboxPlane is not configured; the internal proxy fails closed
      // (empty type list) instead of guessing or falling back to any default.
      baseUrl: process.env.SANDBOXPLANE_BASE_URL || null,
      token: process.env.SANDBOXPLANE_TOKEN || null,
      timeoutMs: Number(optionalEnv("SANDBOXPLANE_TIMEOUT_MS", "5000")),
    },
    log: {
      level: optionalEnv("LOG_LEVEL", "info"),
    },
  };
}
