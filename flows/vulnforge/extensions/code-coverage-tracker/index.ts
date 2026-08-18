import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageMap,
  persistCoverageMap,
  recordReadCoverageEvent,
} from "../coverage-core.ts";

export default function (pi: ExtensionAPI) {
  const outputDir = process.env.YOUNGFLOW_OUTPUT_DIR;
  const workDir = process.env.YOUNGFLOW_WORK_DIR ?? process.cwd();
  const stage = process.env.YOUNGFLOW_STAGE_ID ?? "unknown";
  if (!outputDir) return;

  const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
  const targetRoot = path.resolve(workDir);
  const resolvedOutputDir = path.resolve(outputDir);

  const map = loadCoverageMap(jsonPath, targetRoot, resolvedOutputDir);
  aggregateCoverageEvents(jsonlPath, map);
  persistCoverageMap(map, jsonPath);

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;
    recordReadCoverageEvent({
      jsonlPath,
      targetRoot,
      stage,
      input: event.input as { path?: string; offset?: number; limit?: number } | undefined,
    });
  });
}
