import { Client as MinioClient } from "minio";
import { logger } from "../logger.js";
import type { ServiceConfig } from "../config.js";

let _minio: MinioClient | null = null;

export function getMinio(): MinioClient {
  if (!_minio) throw new Error("MinIO client not initialized — call initMinio() first");
  return _minio;
}

export async function initMinio(config: ServiceConfig["minio"]): Promise<MinioClient> {
  _minio = new MinioClient({
    endPoint: config.endpoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });

  // Ensure bucket exists
  const exists = await _minio.bucketExists(config.bucket);
  if (!exists) {
    await _minio.makeBucket(config.bucket);
    logger.info({ bucket: config.bucket }, "MinIO bucket created");
  }

  logger.info({ endpoint: config.endpoint, bucket: config.bucket }, "MinIO connected");
  return _minio;
}

export async function uploadFile(
  bucket: string,
  key: string,
  data: Buffer | import('stream').Readable,
  size?: number,
  contentType = "application/octet-stream",
): Promise<void> {
  const minio = getMinio();
  const metaData = { "Content-Type": contentType };
  if (Buffer.isBuffer(data)) {
    await minio.putObject(bucket, key, data, data.length, metaData);
  } else {
    await minio.putObject(bucket, key, data, size, metaData);
  }
}

export async function getObjectStream(bucket: string, key: string): Promise<import('stream').Readable> {
  return getMinio().getObject(bucket, key);
}

export async function removeObject(bucket: string, key: string): Promise<void> {
  await getMinio().removeObject(bucket, key);
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getMinio().statObject(bucket, key);
    return true;
  } catch {
    return false;
  }
}
