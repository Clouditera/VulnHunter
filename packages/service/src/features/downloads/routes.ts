/**
 * DeVeye toolkit download routes.
 * Streams platform-specific toolkit (CLI binary + extension + setup script) as tar.gz/zip.
 */

import { Hono } from "hono";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../../infra/logger.js";

export const downloadsRouter = new Hono();

// In dev mode, set DEVEYE_TOOLKIT_DIR; in Docker, files are at /opt/deveye-toolkits
const TOOLKIT_BASE = process.env.DEVEYE_TOOLKIT_DIR || "/opt/deveye-toolkits";

const PLATFORM_MAP: Record<string, { binary: string; outName: string; setupScript: string; format: "tar.gz" | "zip" }> = {
  linux: { binary: "index-linux", outName: "deveye", setupScript: "setup.sh", format: "tar.gz" },
  windows: { binary: "index-win.exe", outName: "deveye.exe", setupScript: "setup.bat", format: "zip" },
  macos: { binary: "index-macos", outName: "deveye", setupScript: "setup.sh", format: "tar.gz" },
};

// GET /api/downloads/deveye/toolkit?platform=linux|windows|macos
downloadsRouter.get("/deveye/toolkit", async (c) => {
  const platform = (c.req.query("platform") || "linux").toLowerCase();
  const spec = PLATFORM_MAP[platform];
  if (!spec) {
    return c.json({ error: { code: "ERR_VALIDATION", message: `Invalid platform: ${platform}. Use: linux, windows, macos` } }, 400);
  }

  const binariesDir = join(TOOLKIT_BASE, "binaries");
  const extensionDir = join(TOOLKIT_BASE, "extension-dist");
  const setupDir = join(TOOLKIT_BASE, "setup");
  const binaryPath = join(binariesDir, spec.binary);

  if (!existsSync(binaryPath)) {
    logger.warn({ platform, binaryPath }, "DeVeye toolkit binary not found");
    return c.json({ error: { code: "ERR_NOT_FOUND", message: "DeVeye toolkit not available for this platform" } }, 404);
  }

  const tmpDir = `/tmp/deveye-toolkit-${platform}-${Date.now()}`;
  const archiveName = `deveye-toolkit-${platform}`;

  try {
    // Assemble toolkit directory
    execSync(`mkdir -p ${tmpDir}/${archiveName}`);
    execSync(`cp ${binaryPath} ${tmpDir}/${archiveName}/${spec.outName}`);
    if (platform !== "windows") {
      execSync(`chmod +x ${tmpDir}/${archiveName}/${spec.outName}`);
    }
    if (existsSync(extensionDir)) {
      execSync(`cp -r ${extensionDir} ${tmpDir}/${archiveName}/extension-dist`);
    }
    // Copy setup script
    const setupSrc = join(setupDir, spec.setupScript);
    if (existsSync(setupSrc)) {
      execSync(`cp ${setupSrc} ${tmpDir}/${archiveName}/${spec.setupScript}`);
      if (platform !== "windows") {
        execSync(`chmod +x ${tmpDir}/${archiveName}/${spec.setupScript}`);
      }
    }

    let archivePath: string;
    let contentType: string;
    let fileName: string;

    if (spec.format === "zip") {
      archivePath = `${tmpDir}/${archiveName}.zip`;
      fileName = `${archiveName}.zip`;
      contentType = "application/zip";
      execSync(`cd ${tmpDir} && zip -r ${archiveName}.zip ${archiveName}/`);
    } else {
      archivePath = `${tmpDir}/${archiveName}.tar.gz`;
      fileName = `${archiveName}.tar.gz`;
      contentType = "application/gzip";
      execSync(`cd ${tmpDir} && tar czf ${archiveName}.tar.gz ${archiveName}/`);
    }

    const stat = statSync(archivePath);
    const stream = createReadStream(archivePath);

    // Cleanup after stream ends
    stream.on("close", () => {
      try { execSync(`rm -rf ${tmpDir}`); } catch { /* ignore */ }
    });

    c.header("Content-Type", contentType);
    c.header("Content-Disposition", `attachment; filename="${fileName}"`);
    c.header("Content-Length", String(stat.size));

    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(stat.size),
      },
    });
  } catch (err) {
    logger.error({ err, platform }, "Failed to build DeVeye toolkit");
    try { execSync(`rm -rf ${tmpDir}`); } catch { /* ignore */ }
    return c.json({ error: { code: "ERR_INTERNAL", message: "Failed to build toolkit" } }, 500);
  }
});
