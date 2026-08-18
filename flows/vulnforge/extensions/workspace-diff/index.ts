/**
 * Workspace Diff Extension
 *
 * Gives the decide stage a git-diff view of what changed in the output
 * directory between two decide rounds. Backed by an isolated git repository
 * (git-dir under .youngflow/wsdiff-git, work-tree = output_dir) so it never
 * touches the audited project's git or VulnForge's own git.
 *
 * Two tools (read/baseline split so the snapshot timing is under decide's
 * control):
 *   workspace_diff()      — read-only: current work-tree vs last snapshot.
 *   workspace_snapshot()  — commit current full output_dir as the new baseline.
 *
 * Typical decide turn:
 *   1. workspace_diff()      at the start  → see what execution stages did.
 *   2. (decide does its work: update routing/tasks/worklog)
 *   3. workspace_snapshot()  at the end    → fix a new baseline that already
 *      includes decide's own writes, so next round's diff is pure execution
 *      delta.
 *
 * Environment (set by YoungFlow engine):
 *   YOUNGFLOW_OUTPUT_DIR  - output root (work-tree)
 *   YOUNGFLOW_STAGE_ID    - current stage id
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Lines written into the isolated repo's info/exclude. The snapshot tracks the
// full output_dir and excludes only YoungFlow's own engine internals to avoid
// recursively committing the isolated git repo and session state.
const EXCLUDE_LINES = [
  "/.youngflow/",
];

export default function (pi: ExtensionAPI) {
  const outputDir = process.env.YOUNGFLOW_OUTPUT_DIR;
  if (!outputDir) return;

  const gitDir = path.join(outputDir, ".youngflow", "wsdiff-git");
  const workTree = path.resolve(outputDir);

  // Common git arg prefix pinning the isolated repo + work-tree.
  const gitBase = (): string[] => [
    "--git-dir",
    gitDir,
    "--work-tree",
    workTree,
  ];

  const run = async (args: string[]) => {
    const res = await pi.exec("git", [...gitBase(), ...args], { cwd: workTree });
    return res;
  };

  // Lazily init the isolated repo on first use.
  const ensureRepo = async (): Promise<void> => {
    if (existsSync(path.join(gitDir, "HEAD"))) return;
    mkdirSync(gitDir, { recursive: true });
    await pi.exec("git", ["--git-dir", gitDir, "init", "-q"], { cwd: workTree });
    // Identity so commits never fail on an unconfigured machine.
    await run(["config", "user.email", "wsdiff@vulnforge.local"]);
    await run(["config", "user.name", "workspace-diff"]);
    // Detect file moves/renames between snapshots.
    await run(["config", "diff.renames", "true"]);
    // Scope tracked content.
    const excludePath = path.join(gitDir, "info", "exclude");
    mkdirSync(path.dirname(excludePath), { recursive: true });
    writeFileSync(excludePath, EXCLUDE_LINES.join("\n") + "\n");
  };

  const hasBaseline = async (): Promise<boolean> => {
    const res = await pi.exec(
      "git",
      [...gitBase(), "rev-parse", "--verify", "-q", "HEAD"],
      { cwd: workTree },
    );
    return res.code === 0;
  };

  // -------------------------------------------------------------------------
  // workspace_diff — read-only
  // -------------------------------------------------------------------------
  pi.registerTool(defineTool({
    name: "workspace_diff",
    label: "Workspace Diff",
    description:
      "查看自上一次 workspace_snapshot 基线以来 output_dir 的文件变化。纯读，不改基线。新增、删除、移动/重命名与行级改动（如 status/poc_status 迁移）都按 git diff 原样呈现。",
    promptSnippet:
      "workspace_diff(scope?, stat?) — 查看自上轮基线以来工作区的变化。省略 scope 看全部；stat 默认 true 给文件级概览，false 给完整 patch。",
    parameters: Type.Object({
      scope: Type.Optional(
        Type.String({
          description:
            "限定到 output_dir 下某个相对路径或具体文件；省略则覆盖整个 output_dir。",
        }),
      ),
      stat: Type.Optional(
        Type.Boolean({
          description:
            "true 返回 --stat 文件级概览（默认，省 token）；false 返回完整 patch（看行级 status/poc_status 迁移）。",
          default: true,
        }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      await ensureRepo();

      if (!(await hasBaseline())) {
        return {
          content: [{
            type: "text" as const,
            text: "尚无基线（本次运行还没有调用过 workspace_snapshot）。请先调用 workspace_snapshot() 固化首个基线，之后的 workspace_diff 才能显示增量。",
          }],
        };
      }

      const stat = params.stat ?? true;
      // Stage current state into the index without committing, so the diff
      // reflects the full current work-tree (including untracked new files).
      const spec = params.scope ? [params.scope] : ["."];
      await run(["add", "-A", "--", ...spec]);

      const diffArgs = [
        "diff",
        "--cached",
        "-M", // rename detection
        stat ? "--stat" : "--patch",
      ];
      if (params.scope) diffArgs.push("--", params.scope);
      const res = await run(diffArgs);

      const body = res.stdout.trim();
      const header = `## 自上轮基线以来的工作区变化${params.scope ? `（scope: ${params.scope}）` : ""}`;
      const text = body.length > 0
        ? `${header}\n\n\`\`\`diff\n${body}\n\`\`\``
        : `${header}\n\n（无变化）`;

      return {
        content: [{ type: "text" as const, text }],
        details: { changed: body.length > 0, scope: params.scope ?? null, stat },
      };
    },
  }));

  // -------------------------------------------------------------------------
  // workspace_snapshot — commit a new full baseline
  // -------------------------------------------------------------------------
  pi.registerTool(defineTool({
    name: "workspace_snapshot",
    label: "Workspace Snapshot",
    description:
      "把整个 output_dir 的当前状态固化为新基线（独立 git 仓库的一次 commit），供下一轮 workspace_diff 比对。基线始终全量记录，无参数。",
    promptSnippet:
      "workspace_snapshot() — 固化当前工作区为新基线。decide 在本轮收尾、写完 decision/tasks/worklog 后调用一次。",
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      await ensureRepo();

      const spec = ["."];
      await run(["add", "-A", "--", ...spec]);

      const hadBaseline = await hasBaseline();

      // Short stat of what this baseline absorbs relative to the previous one.
      const statArgs = hadBaseline
        ? ["diff", "--cached", "-M", "--stat"]
        : ["diff", "--cached", "-M", "--stat", "--", ...spec];
      const statRes = await run(statArgs);
      const stat = statRes.stdout.trim();

      // Nothing staged and a baseline already exists → no-op commit guard.
      if (hadBaseline && stat.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "本轮无新增/改动，基线未变（与上一基线一致）。",
          }],
          details: { committed: false, changed: false },
        };
      }

      const msg = hadBaseline ? "decide round baseline" : "initial baseline";
      const commitRes = await run(["commit", "-q", "-m", msg, "--allow-empty"]);
      const headRes = await run(["rev-parse", "--short", "HEAD"]);
      const head = headRes.stdout.trim();

      const text = hadBaseline
        ? `已固化新基线 ${head}。本次纳入的变化：\n\n\`\`\`\n${stat || "(无差异)"}\n\`\`\``
        : `已建立首个基线 ${head}（记录了当前 output_dir 全量）。`;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          committed: commitRes.code === 0,
          head,
          initial: !hadBaseline,
        },
      };
    },
  }));
}
