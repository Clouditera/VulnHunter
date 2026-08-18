import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageMap,
  persistCoverageMap,
  renderCoverage,
} from "../coverage-core.ts";

export default function (pi: ExtensionAPI) {
  const outputDir = process.env.YOUNGFLOW_OUTPUT_DIR;
  const workDir = process.env.YOUNGFLOW_WORK_DIR ?? process.cwd();
  if (!outputDir) return;

  const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
  const targetRoot = path.resolve(workDir);
  const resolvedOutputDir = path.resolve(outputDir);

  const map = loadCoverageMap(jsonPath, targetRoot, resolvedOutputDir);
  aggregateCoverageEvents(jsonlPath, map);
  persistCoverageMap(map, jsonPath);

  pi.registerTool(defineTool({
    name: "coverage",
    label: "Coverage",
    description: "查看代码阅读覆盖率。像 tree 命令一样浏览项目的代码阅读覆盖情况。",
    promptSnippet: "coverage(path?, depth?) — 查看代码阅读覆盖率树。不传参数返回全局概览，传目录路径展开子项，传文件路径查看行级覆盖详情。depth 控制展开深度（默认 1）。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "目录或文件路径（相对于项目根目录）。省略则显示项目根级概览。" })),
      depth: Type.Optional(Type.Number({ description: "目录树展开深度，默认 1。类似 tree -L。", default: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (aggregateCoverageEvents(jsonlPath, map)) {
        persistCoverageMap(map, jsonPath);
      }

      return {
        content: [{ type: "text" as const, text: renderCoverage(map, params) }],
      };
    },
  }));
}
