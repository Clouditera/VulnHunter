#!/usr/bin/env python3
"""分析器模块 - 依赖、结构和安全分析。"""

from .dependency import (
    BACKEND_FRAMEWORKS,
    DEPENDENCY_FILES,
    FRONTEND_FRAMEWORKS,
    GRPC_DEPENDENCIES,
    detect_grpc_dependencies,
    detect_language,
    load_text,
    read_json_safe,
)
from .security import (
    detect_backend_service,
    detect_frontend_app,
    detect_grpc_service,
    detect_tcp_service,
)
from .structure import (
    ENTRY_FILES,
    ROUTE_PATTERNS,
    count_code_files,
    detect_framework_type,
    detect_monorepo_packages,
    detect_test_dirs,
    find_entry_points,
    find_router_files_with_snippets,
    get_main_dirs,
    resolve_search_paths,
)

__all__ = [
    # dependency
    "BACKEND_FRAMEWORKS",
    "DEPENDENCY_FILES",
    "FRONTEND_FRAMEWORKS",
    "GRPC_DEPENDENCIES",
    "detect_grpc_dependencies",
    "detect_language",
    "load_text",
    "read_json_safe",
    # security
    "detect_backend_service",
    "detect_frontend_app",
    "detect_grpc_service",
    "detect_tcp_service",
    # structure
    "ENTRY_FILES",
    "ROUTE_PATTERNS",
    "count_code_files",
    "detect_framework_type",
    "detect_monorepo_packages",
    "detect_test_dirs",
    "find_entry_points",
    "find_router_files_with_snippets",
    "get_main_dirs",
    "resolve_search_paths",
]
