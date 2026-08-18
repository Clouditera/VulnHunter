#!/usr/bin/env python3
"""项目基本信息快速收集脚本。

依据 `.claude/skills/project-profiler/SKILL.md` 的判定标准，
快速收集项目基本信息并打印结果：
1) 项目分类（后端HTTP服务、前端WEB应用、TCP端口服务、安全测试靶场）
2) 技术栈（主要语言、框架、包管理器）
3) 代码统计（文件数量、代码行数、主要目录结构）
4) 入口点（主入口文件、路由入口）
5) TCP端口服务检测（gRPC服务、TCP/UDP监听服务）

**重构说明**：
本文件已重构为导入别名和 CLI 入口，核心逻辑已拆分到 profile_basic_scan/ 模块：
- profile_basic_scan/scanner.py: ProfileScanner 主类
- profile_basic_scan/analyzers/dependency.py: 依赖分析
- profile_basic_scan/analyzers/structure.py: 结构分析
- profile_basic_scan/analyzers/security.py: 安全分析
"""

import argparse
import sys
from pathlib import Path

# 导入拆分后的模块
from profile_basic_scan import ProfileScanner


def main() -> None:
    """CLI 主入口函数。"""
    parser = argparse.ArgumentParser(description="项目基本信息快速收集")
    parser.add_argument(
        "path",
        nargs="?",
        default=".",
        help="要检测的项目路径，默认当前目录",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        help="输出文件路径，如果不指定则输出到标准输出",
    )
    args = parser.parse_args()

    try:
        # 创建扫描器并执行扫描
        scanner = ProfileScanner(Path(args.path))
        result = scanner.scan()

        # 格式化输出
        output = scanner.format_output(result)

        # 根据是否指定输出文件决定输出方式
        if args.output:
            output_path = Path(args.output)
            try:
                # 确保输出目录存在
                output_path.parent.mkdir(parents=True, exist_ok=True)
                # 写入文件
                output_path.write_text(output, encoding="utf-8")
                print(f"结果已保存到: {output_path}", file=sys.stderr)
            except Exception as e:
                print(f"写入文件失败: {e}", file=sys.stderr)
                # 失败时仍然输出到标准输出
                print(output)
        else:
            print(output)

    except ValueError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"扫描失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
