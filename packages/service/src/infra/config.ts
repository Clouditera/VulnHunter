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
  };
  log: {
    level: string;
  };
}

export function loadConfig(): ServiceConfig {
  return {
    port: Number(optionalEnv("PORT", "28080")),
    dataDir: optionalEnv("DATA_DIR", "/data/vulnhunt"),
    db: {
      url: optionalEnv("DATABASE_URL", "postgresql://vulnhunt:vulnhunt@localhost:25432/vulnhunt"),
    },
    minio: {
      endpoint: optionalEnv("MINIO_ENDPOINT", "localhost"),
      port: Number(optionalEnv("MINIO_PORT", "29000")),
      useSSL: optionalEnv("MINIO_USE_SSL", "false") === "true",
      accessKey: optionalEnv("MINIO_ACCESS_KEY", "minioadmin"),
      secretKey: optionalEnv("MINIO_SECRET_KEY", "minioadmin"),
      bucket: optionalEnv("MINIO_BUCKET", "vulnhunt"),
    },
    docker: {
      socketPath: optionalEnv("DOCKER_SOCKET", "/var/run/docker.sock"),
      workerImage: optionalEnv("WORKER_IMAGE", "vulnhunt-worker:latest"),
      evalWorkerImage: optionalEnv("EVAL_WORKER_IMAGE", "vulnhunt-eval-worker:latest"),
      network: optionalEnv("DOCKER_NETWORK", "vulnhunt-internal"),
    },
    log: {
      level: optionalEnv("LOG_LEVEL", "info"),
    },
  };
}
