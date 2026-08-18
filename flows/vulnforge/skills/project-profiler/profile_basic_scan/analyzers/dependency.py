#!/usr/bin/env python3
"""依赖分析模块 - 识别项目依赖、语言、框架和包管理器。"""

import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# 依赖配置文件映射到语言
DEPENDENCY_FILES = {
    "package.json": "JavaScript/TypeScript",
    "go.mod": "Go",
    "pom.xml": "Java",
    "build.gradle": "Java",
    "build.gradle.kts": "Java",
    "requirements.txt": "Python",
    "pyproject.toml": "Python",
    "composer.json": "PHP",
    "Cargo.toml": "Rust",
    "Gemfile": "Ruby",
    "build.sbt": "Scala",
}

# 后端 Web 框架关键词
BACKEND_FRAMEWORKS = {
    "JavaScript/TypeScript": ["express", "koa", "fastify", "nest", "hapi"],
    "Python": ["flask", "fastapi", "django", "tornado", "bottle", "sanic", "quart"],
    "Java": ["spring-boot", "spring-web", "springframework", "play-framework", "vertx"],
    "Go": ["gin-gonic/gin", "echo", "chi", "gorilla/mux", "fiber", "beego"],
    "PHP": ["laravel", "symfony", "codeigniter", "yii", "slim"],
    ".NET": ["AspNetCore", "Microsoft.AspNetCore"],
    "Rust": ["actix-web", "rocket", "warp", "axum"],
    "Ruby": ["rails", "sinatra", "grape"],
    "Scala": ["play-framework", "akka-http", "http4s"],
    "Kotlin": ["ktor", "spring-boot"],
}

# 前端框架关键词
FRONTEND_FRAMEWORKS = {
    "react",
    "vue",
    "angular",
    "svelte",
    "next",
    "nuxt",
    "remix",
    "gatsby",
    "vite",
}

# gRPC 相关依赖关键词
GRPC_DEPENDENCIES = {
    "JavaScript/TypeScript": ["@grpc/grpc-js", "grpc", "@grpc/proto-loader"],
    "Python": ["grpcio", "grpcio-tools"],
    "Java": ["grpc", "io.grpc"],
    "Go": ["google.golang.org/grpc", "github.com/grpc/grpc-go"],
    ".NET": ["Grpc", "Grpc.Net.Client", "Grpc.AspNetCore"],
    "Rust": ["tonic", "grpcio"],
    "Ruby": ["grpc"],
    "Scala": ["io.grpc"],
}


def read_json_safe(path: Path) -> dict:
    """安全读取 JSON，异常返回空 dict。"""
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def load_text(path: Path) -> str:
    """读取文本文件内容，失败返回空字符串。"""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def detect_language(root: Path) -> tuple[str | None, str | None, str | None]:
    """检测主要语言、框架和包管理器。

    返回: (language, framework, package_manager)
    """
    language = None
    framework = None
    package_manager = None

    # 检测语言和包管理器
    for dep_file, lang in DEPENDENCY_FILES.items():
        if (root / dep_file).exists():
            language = lang
            if dep_file == "package.json":
                package_manager = "npm/yarn/pnpm"
            elif dep_file in ("pom.xml", "build.gradle", "build.gradle.kts"):
                package_manager = "Maven/Gradle"
            elif dep_file == "go.mod":
                package_manager = "go mod"
            elif dep_file in ("requirements.txt", "pyproject.toml"):
                package_manager = "pip/poetry"
            elif dep_file == "composer.json":
                package_manager = "composer"
            elif dep_file == "Cargo.toml":
                package_manager = "cargo"
            elif dep_file == "Gemfile":
                package_manager = "bundler"
            elif dep_file == "build.sbt":
                package_manager = "sbt"
            break

    # 检测 .NET
    if not language:
        csproj_files = list(root.glob("*.csproj"))
        if csproj_files:
            language = ".NET"
            package_manager = "NuGet"

    # 检测框架
    if language:
        framework = _detect_framework(root, language)

    return language, framework, package_manager


def _detect_framework(root: Path, language: str) -> str | None:
    """检测框架类型。"""
    if language == "JavaScript/TypeScript":
        return _detect_js_framework(root)
    elif language == "Python":
        return _detect_python_framework(root)
    elif language == "Java":
        return _detect_java_framework(root)
    elif language == "Go":
        return _detect_go_framework(root)
    elif language == "PHP":
        return _detect_php_framework(root)
    elif language == ".NET":
        return _detect_dotnet_framework(root)
    elif language == "Rust":
        return _detect_rust_framework(root)
    elif language == "Ruby":
        return _detect_ruby_framework(root)
    elif language == "Scala":
        return _detect_scala_framework(root)
    return None


def _detect_js_framework(root: Path) -> str | None:
    """检测 JavaScript/TypeScript 框架。"""
    pkg_json = read_json_safe(root / "package.json")
    deps = {**pkg_json.get("dependencies", {}), **pkg_json.get("devDependencies", {})}

    for dep_name in deps:
        # 检测后端框架
        for fw in BACKEND_FRAMEWORKS.get("JavaScript/TypeScript", []):
            if fw.lower() in dep_name.lower():
                return fw
        # 检测前端框架
        for fw in FRONTEND_FRAMEWORKS:
            if fw.lower() in dep_name.lower():
                return fw

    # Check monorepo sub-packages
    from .structure import detect_monorepo_packages

    for pkg_dir in detect_monorepo_packages(root):
        sub_pkg_json = read_json_safe(pkg_dir / "package.json")
        sub_deps = {**sub_pkg_json.get("dependencies", {}), **sub_pkg_json.get("devDependencies", {})}
        for dep_name in sub_deps:
            for fw in BACKEND_FRAMEWORKS.get("JavaScript/TypeScript", []):
                if fw.lower() in dep_name.lower():
                    return fw
    return None


def _detect_python_framework(root: Path) -> str | None:
    """检测 Python 框架。"""
    for dep_file in ("requirements.txt", "pyproject.toml"):
        path = root / dep_file
        if path.exists():
            content = load_text(path).lower()
            for fw in BACKEND_FRAMEWORKS.get("Python", []):
                if fw.lower() in content:
                    return fw
    return None


def _detect_java_framework(root: Path) -> str | None:
    """检测 Java 框架。"""
    for dep_file in ("pom.xml", "build.gradle", "build.gradle.kts"):
        path = root / dep_file
        if path.exists():
            content = load_text(path).lower()
            for fw in BACKEND_FRAMEWORKS.get("Java", []):
                if fw.lower() in content:
                    return fw
    return None


def _detect_go_framework(root: Path) -> str | None:
    """检测 Go 框架。"""
    go_mod = root / "go.mod"
    if go_mod.exists():
        content = load_text(go_mod)
        for fw in BACKEND_FRAMEWORKS.get("Go", []):
            if fw.lower() in content.lower():
                return fw.split("/")[-1]  # 提取框架名
    return None


def _detect_php_framework(root: Path) -> str | None:
    """检测 PHP 框架。"""
    composer_json = read_json_safe(root / "composer.json")
    deps = {**composer_json.get("require", {}), **composer_json.get("require-dev", {})}

    for dep_name in deps:
        for fw in BACKEND_FRAMEWORKS.get("PHP", []):
            if fw.lower() in dep_name.lower():
                return fw
    return None


def _detect_dotnet_framework(root: Path) -> str | None:
    """检测 .NET 框架。"""
    csproj_files = list(root.glob("*.csproj"))
    for csproj in csproj_files:
        content = load_text(csproj).lower()
        if "aspnetcore" in content:
            return "ASP.NET Core"
    return None


def _detect_rust_framework(root: Path) -> str | None:
    """检测 Rust 框架。"""
    cargo_toml = root / "Cargo.toml"
    if cargo_toml.exists():
        content = load_text(cargo_toml).lower()
        for fw in BACKEND_FRAMEWORKS.get("Rust", []):
            if fw.lower() in content:
                return fw
    return None


def _detect_ruby_framework(root: Path) -> str | None:
    """检测 Ruby 框架。"""
    gemfile = root / "Gemfile"
    if gemfile.exists():
        content = load_text(gemfile).lower()
        for fw in BACKEND_FRAMEWORKS.get("Ruby", []):
            if fw.lower() in content:
                return fw
    return None


def _detect_scala_framework(root: Path) -> str | None:
    """检测 Scala 框架。"""
    build_sbt = root / "build.sbt"
    if build_sbt.exists():
        content = load_text(build_sbt).lower()
        for fw in BACKEND_FRAMEWORKS.get("Scala", []):
            if fw.lower() in content:
                return fw

    # Scala 也可能使用 Maven/Gradle
    for dep_file in ("pom.xml", "build.gradle", "build.gradle.kts"):
        path = root / dep_file
        if path.exists():
            content = load_text(path).lower()
            for fw in BACKEND_FRAMEWORKS.get("Scala", []):
                if fw.lower() in content:
                    return fw
    return None


def detect_grpc_dependencies(root: Path, language: str | None) -> tuple[bool, list[str]]:
    """检测 gRPC 相关依赖。

    返回: (是否检测到gRPC, 证据列表)
    """
    evidence = []

    if not language:
        return False, evidence

    # 检查 .proto 文件
    proto_files = list(root.rglob("*.proto"))
    if proto_files:
        proto_count = len(proto_files)
        evidence.append(f"发现 {proto_count} 个 .proto 文件: {', '.join([str(p.relative_to(root)) for p in proto_files[:3]])}")
        if proto_count > 3:
            evidence[0] += f" ... 还有 {proto_count - 3} 个 .proto 文件"

    # 检查依赖文件中的 gRPC 库
    grpc_deps = GRPC_DEPENDENCIES.get(language, [])
    if not grpc_deps:
        return bool(proto_files), evidence

    if language == "JavaScript/TypeScript":
        pkg_json = read_json_safe(root / "package.json")
        deps = {**pkg_json.get("dependencies", {}), **pkg_json.get("devDependencies", {})}
        for dep_name in deps:
            for grpc_dep in grpc_deps:
                if grpc_dep.lower() in dep_name.lower():
                    evidence.append(f"依赖文件包含 gRPC 库: {dep_name}")
                    return True, evidence
    elif language == "Python":
        for dep_file in ("requirements.txt", "pyproject.toml"):
            path = root / dep_file
            if path.exists():
                content = load_text(path).lower()
                for grpc_dep in grpc_deps:
                    if grpc_dep.lower() in content:
                        evidence.append(f"{dep_file} 包含 gRPC 库: {grpc_dep}")
                        return True, evidence
    elif language in ("Java", "Scala"):
        for dep_file in ("pom.xml", "build.gradle", "build.gradle.kts", "build.sbt"):
            path = root / dep_file
            if path.exists():
                content = load_text(path).lower()
                for grpc_dep in grpc_deps:
                    if grpc_dep.lower() in content:
                        evidence.append(f"{dep_file} 包含 gRPC 库: {grpc_dep}")
                        return True, evidence
    elif language == "Go":
        go_mod = root / "go.mod"
        if go_mod.exists():
            content = load_text(go_mod)
            for grpc_dep in grpc_deps:
                if grpc_dep.lower() in content.lower():
                    evidence.append(f"go.mod 包含 gRPC 库: {grpc_dep}")
                    return True, evidence
    elif language == ".NET":
        csproj_files = list(root.glob("*.csproj"))
        for csproj in csproj_files:
            content = load_text(csproj).lower()
            for grpc_dep in grpc_deps:
                if grpc_dep.lower() in content:
                    evidence.append(f"{csproj.name} 包含 gRPC 库: {grpc_dep}")
                    return True, evidence
    elif language == "Rust":
        cargo_toml = root / "Cargo.toml"
        if cargo_toml.exists():
            content = load_text(cargo_toml).lower()
            for grpc_dep in grpc_deps:
                if grpc_dep.lower() in content:
                    evidence.append(f"Cargo.toml 包含 gRPC 库: {grpc_dep}")
                    return True, evidence
    elif language == "Ruby":
        gemfile = root / "Gemfile"
        if gemfile.exists():
            content = load_text(gemfile).lower()
            for grpc_dep in grpc_deps:
                if grpc_dep.lower() in content:
                    evidence.append(f"Gemfile 包含 gRPC 库: {grpc_dep}")
                    return True, evidence

    # 如果有 .proto 文件但没有找到依赖，仍然认为可能是 gRPC
    return bool(proto_files), evidence
