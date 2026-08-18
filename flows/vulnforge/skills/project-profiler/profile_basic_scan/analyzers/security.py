#!/usr/bin/env python3
"""安全分析模块 - 检测项目类型、TCP/gRPC服务和安全测试靶场特征。"""

import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from .dependency import (
    BACKEND_FRAMEWORKS,
    GRPC_DEPENDENCIES,
    load_text,
    read_json_safe,
)
from .structure import detect_monorepo_packages, resolve_search_paths

# TCP/UDP 服务相关代码模式（按语言分类）
TCP_SERVER_PATTERNS = {
    "JavaScript/TypeScript": [
        r"net\.createServer\(",
        r"socket\.listen\(",
        r"server\.listen\(",
    ],
    "Python": [
        r"socket\.socket\(",
        r"socketserver\.(TCPServer|UDPServer)",
        r"\.bind\(",
        r"\.listen\(",
    ],
    "Java": [
        r"ServerSocket\(",
        r"DatagramSocket\(",
        r"\.bind\(",
        r"\.accept\(",
    ],
    "Go": [
        r"net\.Listen\(",
        r"net\.ListenUDP\(",
        r"net\.ListenTCP\(",
        r"\.Accept\(",
    ],
    ".NET": [
        r"TcpListener\(",
        r"UdpClient\(",
        r"\.Start\(",
        r"\.AcceptTcpClient\(",
    ],
    "Rust": [
        r"TcpListener::bind\(",
        r"UdpSocket::bind\(",
        r"\.listen\(",
        r"\.accept\(",
    ],
    "Ruby": [
        r"TCPServer\.new\(",
        r"UDPSocket\.new\(",
        r"\.listen\(",
    ],
    "Scala": [
        r"ServerSocket\(",
        r"DatagramSocket\(",
    ],
}

# gRPC 服务相关代码模式（按语言分类）
GRPC_SERVER_PATTERNS = {
    "JavaScript/TypeScript": [
        r"@grpc/grpc-js",
        r"\.addService\(",
        r"server\.bindAsync\(",
        r"\.start\(",
    ],
    "Python": [
        r"grpc\.server\(",
        r"add_.*Servicer_to_server\(",
        r"\.start\(",
        r"\.wait_for_termination\(",
    ],
    "Java": [
        r"ServerBuilder",
        r"\.addService\(",
        r"\.build\(\)\.start\(",
        r"io\.grpc\.Server",
    ],
    "Go": [
        r"google\.golang\.org/grpc",
        r"\.RegisterService\(",
        r"\.Serve\(",
        r"grpc\.NewServer\(",
    ],
    ".NET": [
        r"MapGrpcService\(",
        r"\.AddGrpc\(",
        r"Grpc\.Service",
    ],
    "Rust": [
        r"tonic::transport::Server",
        r"\.add_service\(",
        r"\.serve\(",
    ],
    "Ruby": [
        r"GRPC\.RpcServer\.new\(",
        r"\.add_http2_port\(",
    ],
    "Scala": [
        r"ServerBuilder",
        r"\.addService\(",
    ],
}

# 路由注册模式（简化版，用于后端服务检测）
ROUTE_PATTERNS = {
    "JavaScript/TypeScript": [
        r"app\.(get|post|put|delete|patch|use)\(",
        r"router\.(get|post|put|delete|patch)\(",
    ],
    "Python": [
        r"@app\.(route|get|post|put|delete)\(",
        r"app\.(route|get|post|put|delete)\(",
        r"urlpatterns\s*=",
    ],
    "Java": [
        r"@(RestController|Controller)",
        r"@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)",
    ],
    "Go": [
        r"router\.(GET|POST|PUT|DELETE|PATCH)\(",
        r"e\.(GET|POST|PUT|DELETE|PATCH)\(",
        r"r\.(Get|Post|Put|Delete|Patch)\(",
        r"http\.(HandleFunc|ServeMux)",
    ],
    "PHP": [
        r"Route::(get|post|put|delete|patch|any)\(",
        r"@Route\(",
    ],
    ".NET": [
        r"MapGet\(",
        r"MapPost\(",
        r"MapControllers\(",
    ],
    "Rust": [
        r"web::(resource|scope|route)\(",
        r"#\[(get|post|put|delete|patch)\(",
        r"warp::(get|post|put|delete|filter)\(",
    ],
    "Ruby": [
        r"get\s+['\"]",
        r"post\s+['\"]",
        r"resources\s+:",
    ],
    "Scala": [
        r"Routes\(",
        r"@Action",
    ],
}


def detect_backend_service(root: Path, language: str | None) -> tuple[bool, list[str]]:
    """检测是否为后端HTTP服务。

    返回: (是否为后端服务, 证据列表)
    """
    evidence = []

    if not language:
        return False, evidence

    # 方法一：检查依赖文件中的框架
    has_framework = _check_backend_frameworks(root, language, evidence)
    if has_framework:
        return True, evidence

    # 方法二：检查路由特征
    has_routes = _check_route_patterns(root, language, evidence)
    if has_routes:
        return True, evidence

    return False, evidence


def _check_backend_frameworks(root: Path, language: str, evidence: list[str]) -> bool:
    """检查依赖文件中的后端框架。"""
    if language == "JavaScript/TypeScript":
        pkg_json = read_json_safe(root / "package.json")
        deps = {**pkg_json.get("dependencies", {}), **pkg_json.get("devDependencies", {})}
        for dep_name in deps:
            for fw in BACKEND_FRAMEWORKS.get(language, []):
                if fw.lower() in dep_name.lower():
                    evidence.append(f"依赖文件包含后端框架: {dep_name}")
                    return True
        # Check monorepo sub-packages
        for pkg_dir in detect_monorepo_packages(root):
            sub_pkg_json = read_json_safe(pkg_dir / "package.json")
            sub_deps = {**sub_pkg_json.get("dependencies", {}), **sub_pkg_json.get("devDependencies", {})}
            for dep_name in sub_deps:
                for fw in BACKEND_FRAMEWORKS.get(language, []):
                    if fw.lower() in dep_name.lower():
                        evidence.append(f"依赖文件包含后端框架: {dep_name} (在 {pkg_dir.name}/)")
                        return True
    elif language == "Python":
        for dep_file in ("requirements.txt", "pyproject.toml"):
            path = root / dep_file
            if path.exists():
                content = load_text(path).lower()
                for fw in BACKEND_FRAMEWORKS.get(language, []):
                    if fw.lower() in content:
                        evidence.append(f"{dep_file} 包含后端框架: {fw}")
                        return True
    elif language == "Java":
        for dep_file in ("pom.xml", "build.gradle", "build.gradle.kts"):
            path = root / dep_file
            if path.exists():
                content = load_text(path).lower()
                for fw in BACKEND_FRAMEWORKS.get(language, []):
                    if fw.lower() in content:
                        evidence.append(f"{dep_file} 包含后端框架: {fw}")
                        return True
    elif language == "Go":
        go_mod = root / "go.mod"
        if go_mod.exists():
            content = load_text(go_mod)
            for fw in BACKEND_FRAMEWORKS.get(language, []):
                if fw.lower() in content.lower():
                    evidence.append(f"go.mod 包含后端框架: {fw}")
                    return True
        # Go 项目也可能使用标准库 net/http
        if _check_go_http_server(root, evidence):
            return True
    elif language == "PHP":
        composer_json = read_json_safe(root / "composer.json")
        deps = {**composer_json.get("require", {}), **composer_json.get("require-dev", {})}
        for dep_name in deps:
            for fw in BACKEND_FRAMEWORKS.get(language, []):
                if fw.lower() in dep_name.lower():
                    evidence.append(f"composer.json 包含后端框架: {dep_name}")
                    return True
    elif language == ".NET":
        csproj_files = list(root.glob("*.csproj"))
        for csproj in csproj_files:
            content = load_text(csproj).lower()
            if "aspnetcore" in content:
                evidence.append(f"{csproj.name} 包含 ASP.NET Core")
                return True
    elif language == "Rust":
        cargo_toml = root / "Cargo.toml"
        if cargo_toml.exists():
            content = load_text(cargo_toml).lower()
            for fw in BACKEND_FRAMEWORKS.get(language, []):
                if fw.lower() in content:
                    evidence.append(f"Cargo.toml 包含后端框架: {fw}")
                    return True
    elif language == "Ruby":
        gemfile = root / "Gemfile"
        if gemfile.exists():
            content = load_text(gemfile).lower()
            for fw in BACKEND_FRAMEWORKS.get(language, []):
                if fw.lower() in content:
                    evidence.append(f"Gemfile 包含后端框架: {fw}")
                    return True
    elif language == "Scala":
        for dep_file in ("build.sbt", "pom.xml", "build.gradle", "build.gradle.kts"):
            path = root / dep_file
            if path.exists():
                content = load_text(path).lower()
                for fw in BACKEND_FRAMEWORKS.get(language, []):
                    if fw.lower() in content:
                        evidence.append(f"{dep_file} 包含后端框架: {fw}")
                        return True
    return False


def _check_go_http_server(root: Path, evidence: list[str]) -> bool:
    """检查 Go 项目的 HTTP 服务器特征。"""
    code_dirs = ["cmd", "internal", "pkg", "src", "app", "server"]
    http_patterns = [
        r"http\.Server",
        r"http\.ListenAndServe",
        r"http\.Handler",
        r"mux\.Router",
        r"router\.(Handle|HandleFunc|Path|Methods)",
    ]
    for search_path in resolve_search_paths(root, code_dirs):
        for pattern in http_patterns:
            try:
                result = subprocess.run(
                    ["rg", "-l", pattern, search_path],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0 and result.stdout.strip():
                    evidence.append(f"代码中发现 HTTP 服务器特征: {pattern} (在 {search_path})")
                    return True
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass
    return False


def _check_route_patterns(root: Path, language: str, evidence: list[str]) -> bool:
    """检查代码中的路由特征。"""
    code_dirs = ["src", "app", "server", "routes", "api", "controllers"]
    if language == "Go":
        code_dirs.extend(["cmd", "internal", "pkg"])

    patterns = ROUTE_PATTERNS.get(language, [])
    for search_path in resolve_search_paths(root, code_dirs):
        for pattern in patterns:
            try:
                result = subprocess.run(
                    ["rg", "-l", pattern, search_path],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0 and result.stdout.strip():
                    evidence.append(f"代码中发现路由特征: {pattern} (在 {search_path})")
                    return True
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass

    return False


def detect_frontend_app(root: Path) -> tuple[bool, list[str]]:
    """检测是否为前端WEB应用。

    返回: (是否为前端应用, 证据列表)
    """
    from .dependency import FRONTEND_FRAMEWORKS

    evidence = []

    # 检查前端框架依赖
    pkg_json = read_json_safe(root / "package.json")
    deps = {**pkg_json.get("dependencies", {}), **pkg_json.get("devDependencies", {})}
    for dep_name in deps:
        for fw in FRONTEND_FRAMEWORKS:
            if fw.lower() in dep_name.lower():
                evidence.append(f"依赖文件包含前端框架: {dep_name}")
                return True, evidence

    # 检查常见前端目录
    FRONTEND_DIRS = {"ui", "frontend", "client", "www", "webapp", "public"}
    for child in root.iterdir():
        if child.is_dir() and child.name.lower() in FRONTEND_DIRS:
            # 检查目录是否包含前端特征文件
            frontend_markers = {"index.html", "main.ts", "main.js", "index.tsx", "index.jsx", "App.tsx", "App.jsx"}
            if any((child / marker).exists() for marker in frontend_markers):
                evidence.append(f"检测到前端目录: {child.name}/")
                return True, evidence

    # 检查 electron 依赖
    if "electron" in deps:
        evidence.append("检测到 Electron 依赖")
        return True, evidence

    return False, evidence


def detect_grpc_service(root: Path, language: str | None) -> tuple[bool, list[str]]:
    """检测是否为 gRPC 服务。

    返回: (是否为gRPC服务, 证据列表)
    """
    from .dependency import detect_grpc_dependencies

    evidence = []

    if not language:
        return False, evidence

    # 方法一：检查依赖（包括 .proto 文件）
    has_grpc_deps, dep_evidence = detect_grpc_dependencies(root, language)
    evidence.extend(dep_evidence)

    # 方法二：检查代码中的 gRPC 服务器模式
    code_dirs = ["src", "app", "server", "cmd", "internal", "pkg", "services"]
    patterns = GRPC_SERVER_PATTERNS.get(language, [])
    if patterns:
        search_paths = resolve_search_paths(root, code_dirs)

        for search_path in search_paths:
            for pattern in patterns:
                try:
                    result = subprocess.run(
                        ["rg", "-l", pattern, search_path],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        rel_path = Path(search_path).relative_to(root) if search_path != str(root) else "根目录"
                        evidence.append(f"代码中发现 gRPC 服务器特征: {pattern} (在 {rel_path}/)")
                        return True, evidence
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    pass

    return has_grpc_deps, evidence


def detect_tcp_service(root: Path, language: str | None) -> tuple[bool, list[str]]:
    """检测是否为 TCP/UDP 监听服务。

    返回: (是否为TCP服务, 证据列表)
    """
    evidence = []

    if not language:
        return False, evidence

    code_dirs = ["src", "app", "server", "cmd", "internal", "pkg", "services", "network"]
    patterns = TCP_SERVER_PATTERNS.get(language, [])
    if not patterns:
        return False, evidence

    search_paths = resolve_search_paths(root, code_dirs)

    for search_path in search_paths:
        for pattern in patterns:
            try:
                result = subprocess.run(
                    ["rg", "-l", pattern, search_path],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0 and result.stdout.strip():
                    rel_path = Path(search_path).relative_to(root) if search_path != str(root) else "根目录"
                    evidence.append(f"代码中发现 TCP/UDP 服务器特征: {pattern} (在 {rel_path}/)")
                    return True, evidence
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass

    return False, evidence
