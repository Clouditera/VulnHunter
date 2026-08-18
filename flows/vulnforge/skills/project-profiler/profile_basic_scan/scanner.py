#!/usr/bin/env python3
"""项目扫描器 - 主扫描逻辑和报告生成。"""

from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .analyzers import (
    count_code_files,
    detect_backend_service,
    detect_frontend_app,
    detect_grpc_service,
    detect_language,
    detect_tcp_service,
    detect_test_dirs,
    find_entry_points,
    get_main_dirs,
)


class ProfileScanner:
    """项目基本信息扫描器。"""

    def __init__(self, root: Path):
        """初始化扫描器。

        Args:
            root: 项目根目录
        """
        self.root = root.resolve()
        if not self.root.exists():
            raise ValueError(f"路径不存在: {self.root}")

    def scan(self) -> dict:
        """执行完整扫描。

        Returns:
            扫描结果字典，包含：
            - language: 主要语言
            - framework: 框架
            - package_manager: 包管理器
            - is_backend: 是否为后端服务
            - is_frontend: 是否为前端应用
            - is_vtr: 是否为安全靶场
            - is_grpc: 是否为gRPC服务
            - is_tcp: 是否为TCP服务
            - file_count: 文件数量
            - line_count: 代码行数
            - line_count_by_language: 按语言统计的代码行数
            - entry_files: 入口文件列表
            - router_files: 路由文件列表
            - router_snippets: 路由代码片段列表
            - main_dirs: 主要目录列表
            - backend_evidence: 后端服务证据
            - frontend_evidence: 前端应用证据
            - vtr_evidence: 靶场证据
            - grpc_evidence: gRPC证据
            - tcp_evidence: TCP证据
        """
        # 检测技术栈
        language, framework, package_manager = detect_language(self.root)

        # 检测项目分类
        is_backend, backend_evidence = detect_backend_service(self.root, language)
        is_frontend, frontend_evidence = detect_frontend_app(self.root)
        is_grpc, grpc_evidence = detect_grpc_service(self.root, language)
        is_tcp, tcp_evidence = detect_tcp_service(self.root, language)

        # 统计代码
        file_count, line_count, line_count_by_language = count_code_files(self.root)

        # 检查扫描对象有效性：file_count=0 且 loc=0 表示无代码目录
        is_valid_scan_target = not (file_count == 0 and line_count == 0)

        # 查找入口点（传递语言和框架信息用于路由检测）
        entry_files, router_files, router_snippets, frontend_entry_files = find_entry_points(self.root, language, framework)

        # 获取主要目录
        main_dirs = get_main_dirs(self.root)

        # 检测测试目录
        test_dirs = detect_test_dirs(self.root)

        return {
            "language": language,
            "framework": framework,
            "package_manager": package_manager,
            "is_backend": is_backend,
            "is_frontend": is_frontend,
            "is_grpc": is_grpc,
            "is_tcp": is_tcp,
            "file_count": file_count,
            "line_count": line_count,
            "line_count_by_language": line_count_by_language,
            "is_valid_scan_target": is_valid_scan_target,
            "entry_files": entry_files,
            "frontend_entry_files": frontend_entry_files,
            "router_files": router_files,
            "router_snippets": router_snippets,
            "main_dirs": main_dirs,
            "test_dirs": test_dirs,
            "backend_evidence": backend_evidence,
            "frontend_evidence": frontend_evidence,
            "grpc_evidence": grpc_evidence,
            "tcp_evidence": tcp_evidence,
        }

    def format_output(self, result: dict) -> str:
        """格式化输出结果。

        Args:
            result: scan() 返回的结果字典

        Returns:
            格式化后的文本报告
        """
        lines = [""]
        lines.append("== 项目基本信息 ==")
        lines.append("")

        # 项目分类
        lines.append("【项目分类】")
        all_evidence = []
        if result["is_backend"] and result["backend_evidence"]:
            all_evidence.extend(result["backend_evidence"])
        if result["is_frontend"] and result["frontend_evidence"]:
            all_evidence.extend(result["frontend_evidence"])
        if result["is_grpc"] and result["grpc_evidence"]:
            all_evidence.extend(result["grpc_evidence"])
        if result["is_tcp"] and result["tcp_evidence"]:
            all_evidence.extend(result["tcp_evidence"])

        if all_evidence:
            for ev in all_evidence:
                lines.append(f"检测到{ev}特征")
        else:
            lines.append("未检测到明确的分类特征")
        lines.append("")

        # 技术栈
        lines.append("【技术栈】")
        lines.append(f"主要语言: {result['language'] or '未知'}")
        lines.append(f"框架: {result['framework'] or '未知'}")
        lines.append(f"包管理器: {result['package_manager'] or '未知'}")
        lines.append("")

        # 代码统计
        lines.append("【代码统计】")
        lines.append(f"文件数量: {result['file_count']}")
        lines.append(f"代码行数: {result['line_count']:,}")
        if result.get("line_count_by_language"):
            lines.append("按语言统计:")
            language_stats = result["line_count_by_language"]
            sorted_languages = sorted(
                language_stats.items(),
                key=lambda item: item[1].get("code", 0),
                reverse=True,
            )
            for language, stats in sorted_languages:
                code_lines = stats.get("code", 0)
                files = stats.get("files", 0)
                lines.append(f"  - {language}: {code_lines:,} 行 ({files} 文件)")
        if result["main_dirs"]:
            lines.append(f"主要目录: {', '.join(result['main_dirs'])}")
        lines.append("")

        # 测试目录
        if result.get("test_dirs"):
            lines.append("【测试目录】（下游扫描应排除或降级处理）")
            for td in result["test_dirs"]:
                lines.append(f"  - {td}")
            lines.append("")

        # 入口点
        lines.append("【入口点】")
        if result["entry_files"]:
            lines.append(f"主入口文件: {', '.join(result['entry_files'])}")
        else:
            lines.append("主入口文件: 未找到")
        if result.get("frontend_entry_files"):
            lines.append(f"前端入口文件: {', '.join(result['frontend_entry_files'])}")
        elif result.get("is_frontend"):
            lines.append("前端入口文件: 未找到（⚠️ 项目检测为前端类型但未发现前端入口文件）")
        if result["router_files"]:
            lines.append(f"路由文件: {', '.join(result['router_files'][:20])}")
            if len(result["router_files"]) > 20:
                lines.append(f"  ... 还有 {len(result['router_files']) - 20} 个路由文件")
        else:
            lines.append("路由文件: 未找到")
        lines.append("")

        # 路由代码片段
        if result["router_snippets"]:
            lines.append("【路由代码片段】")
            for snippet in result["router_snippets"]:
                lines.append(f"  {snippet}")
            lines.append("")

        return "\n".join(lines)
