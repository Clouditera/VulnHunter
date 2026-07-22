/**
 * Decode archive paths / text content with UTF-8 first, GBK fallback.
 * Spec: UTF-8 that decodes cleanly never falls back (zero false positives).
 */
import { TextDecoder } from "node:util";

let gbkDecoder: TextDecoder | null | undefined;

function getGbkDecoder(): TextDecoder | null {
  if (gbkDecoder !== undefined) return gbkDecoder;
  try {
    gbkDecoder = new TextDecoder("gbk");
    return gbkDecoder;
  } catch {
    gbkDecoder = null;
    return null;
  }
}

export function decodeArchiveBytes(raw: Buffer | Uint8Array, label = "bytes"): string {
  const bytes = raw instanceof Buffer ? raw : Buffer.from(raw);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const gbk = getGbkDecoder();
    if (!gbk) {
      // Last resort: lossy UTF-8 so callers still get a string.
      return new TextDecoder("utf-8").decode(bytes);
    }
    try {
      return gbk.decode(bytes);
    } catch {
      throw new Error(`Cannot decode ${label} as UTF-8 or GBK`);
    }
  }
}

/** yauzl entry.fileName may be string (default) or Buffer when decodeStrings:false. */
export function decodeZipEntryName(fileName: string | Buffer): string {
  if (typeof fileName === "string") {
    // Already decoded by yauzl — may be mojibake for GBK zips that lacked the UTF-8 flag.
    // Recover only when the string is not valid as "round-trip UTF-8 of its own bytes"
    // is impossible; instead try latin1 → gbk when it contains typical mojibake markers
    // is fragile. Prefer decodeStrings:false path so we always get bytes.
    return fileName.replace(/\/+$/, "");
  }
  const decoded = decodeArchiveBytes(fileName, "zip entry name");
  return decoded.replace(/\/+$/, "") || decoded;
}

/**
 * Prefer raw bytes when available. If only a string is present (tar path), keep it.
 * Some tar writers emit UTF-8; GBK tar is rarer — string path is best-effort.
 */
export function decodeTarEntryPath(path: string | Buffer): string {
  if (typeof path !== "string") {
    return decodeArchiveBytes(path, "tar entry path").replace(/\/+$/, "");
  }
  // If the string already looks like valid text without U+FFFD, keep it.
  if (!path.includes("\uFFFD")) return path.replace(/\/+$/, "");
  // Replacement chars: try interpreting the string as latin1 (byte-preserving) then GBK.
  const raw = Buffer.from(path, "latin1");
  return decodeArchiveBytes(raw, "tar entry path").replace(/\/+$/, "");
}

export function decodeTextFileContent(buf: Buffer): string {
  return decodeArchiveBytes(buf, "file content");
}
