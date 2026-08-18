#!/usr/bin/env python3
"""结构分析模块 - 分析项目目录结构、文件统计和入口点。"""

import json
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

# 入口文件
ENTRY_FILES = {
    "main.py",
    "app.py",
    "server.py",
    "main.go",
    "index.js",
    "index.ts",
    "Program.cs",
    "index.php",
    "main.rs",
}

# 前端目录名（用于前端入口文件发现）
FRONTEND_DIRS = {"ui", "frontend", "client", "web", "app"}

# 前端入口文件名
FRONTEND_ENTRY_FILES = {"main.ts", "main.tsx", "main.js", "index.tsx", "App.tsx", "App.vue", "app.ts"}

# 路由注册模式（按框架分类）
ROUTE_PATTERNS = {
    # Express.js
    "express": [
        r"app\.(get|post|put|delete|patch|all|use)\(",
        r"router\.(get|post|put|delete|patch|all)\(",
        r"app\.use\(",
    ],
    # Koa.js
    "koa": [
        r"router\.(get|post|put|delete|patch|all)\(",
        r"app\.use\(",
    ],
    # Fastify
    "fastify": [
        r"fastify\.(get|post|put|delete|patch|register)\(",
    ],
    # NestJS
    "nest": [
        r"@(Get|Post|Put|Delete|Patch|Controller)\(",
        r"@Controller\(",
    ],
    # Flask
    "flask": [
        r"@app\.(route|get|post|put|delete)\(",
        r"app\.(route|get|post|put|delete)\(",
    ],
    # Django
    "django": [
        r"urlpatterns\s*=",
        r"path\(",
        r"re_path\(",
    ],
    # FastAPI
    "fastapi": [
        r"@app\.(get|post|put|delete|patch)\(",
        r"@router\.(get|post|put|delete|patch)\(",
        r"app\.(get|post|put|delete|patch)\(",
    ],
    # Spring Boot
    "spring-boot": [
        r"@(RestController|Controller)",
        r"@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)",
    ],
    # Gin
    "gin": [
        r"router\.(GET|POST|PUT|DELETE|PATCH)\(",
        r"router\.Group\(",
        r"gin\.Default\(",
    ],
    # Echo
    "echo": [
        r"e\.(GET|POST|PUT|DELETE|PATCH)\(",
        r"echo\.New\(",
    ],
    # Chi
    "chi": [
        r"r\.(Get|Post|Put|Delete|Patch)\(",
        r"chi\.NewRouter\(",
    ],
    # Go 标准库
    "go-stdlib": [
        r"router\.(Handle|HandleFunc|Path|Methods)\(",
        r"mux\.Router",
        r"http\.(HandleFunc|ServeMux)",
    ],
    # Laravel
    "laravel": [
        r"Route::(get|post|put|delete|patch|any)\(",
        r"Route::group\(",
    ],
    # Symfony
    "symfony": [
        r"Route\(",
        r"@Route\(",
    ],
    # ASP.NET Core
    "aspnetcore": [
        r"MapGet\(",
        r"MapPost\(",
        r"MapControllers\(",
        r"app\.Map\(",
    ],
    # Hapi.js
    "hapi": [
        r"server\.(route|method)\(",
        r"server\.route\(",
    ],
    # Tornado
    "tornado": [
        r"@tornado\.web\.(get|post|put|delete)\(",
        r"tornado\.web\.Application\(",
        r"\(get|post|put|delete)\(",
    ],
    # Bottle
    "bottle": [
        r"@(route|get|post|put|delete)\(",
        r"bottle\.(route|get|post|put|delete)\(",
    ],
    # Fiber (Go)
    "fiber": [
        r"app\.(Get|Post|Put|Delete|Patch)\(",
        r"fiber\.New\(",
    ],
    # CodeIgniter
    "codeigniter": [
        r"\$route\[",
        r"\$this->router->",
    ],
    # Yii
    "yii": [
        r"UrlManager",
        r"rules\s*=>\s*\[",
    ],
    # Actix (Rust)
    "actix": [
        r"web::(resource|scope|route)\(",
        r"HttpServer::new\(",
    ],
    # Rocket (Rust)
    "rocket": [
        r"#\[(get|post|put|delete|patch)\(",
        r"rocket::build\(",
    ],
    # Warp (Rust)
    "warp": [
        r"warp::(get|post|put|delete|filter)\(",
        r"warp::serve\(",
    ],
    # Rails (Ruby)
    "rails": [
        r"get\s+['\"]",
        r"post\s+['\"]",
        r"resources\s+:",
        r"Rails\.application\.routes",
    ],
    # Sinatra (Ruby)
    "sinatra": [
        r"get\s+['\"]",
        r"post\s+['\"]",
        r"Sinatra::Application",
    ],
    # Play Framework (Scala/Java)
    "play": [
        r"Routes\(",
        r"Action\s*\{",
        r"@Action",
    ],
    # Ktor (Kotlin)
    "ktor": [
        r"get\s*\{",
        r"post\s*\{",
        r"routing\s*\{",
    ],
    # Sanic (Python)
    "sanic": [
        r"@app\.(route|get|post|put|delete)\(",
        r"sanic\.Sanic\(",
    ],
    # Quart (Python)
    "quart": [
        r"@app\.(route|get|post|put|delete)\(",
        r"quart\.Quart\(",
    ],
    # Vert.x (Java)
    "vertx": [
        r"router\.(get|post|put|delete)\(",
        r"Vertx\.vertx\(",
    ],
    # Beego (Go)
    "beego": [
        r"beego\.(Router|NSRouter)\(",
        r"@router\.",
    ],
    # Slim (PHP)
    "slim": [
        r"\$app->(get|post|put|delete)\(",
        r"Slim\App",
    ],
    # Axum (Rust)
    "axum": [
        r"Router::new\(",
        r"\.route\(",
    ],
    # Grape (Ruby)
    "grape": [
        r"class\s+\w+\s+<\s+Grape::API",
        r"get\s+do",
    ],
    # Akka HTTP (Scala)
    "akka-http": [
        r"path\(",
        r"Route\.seal",
    ],
    # http4s (Scala)
    "http4s": [
        r"HttpRoutes\.of\(",
        r"GET\s*->",
    ],
}


def count_code_files(root: Path) -> tuple[int, int, dict[str, dict[str, int]]]:
    """使用 cloc 命令统计代码文件数量和代码行数。

    返回: (文件数量, 代码行数, 按语言统计)
    """
    try:
        exclude_dirs = {
            ".git",
            ".hg",
            ".svn",
            ".bzr",
            ".idea",
            ".vscode",
            ".venv",
            ".workspace",
            ".tox",
            ".mypy_cache",
            ".pytest_cache",
            ".ruff_cache",
            ".cache",
            "node_modules",
            "dist",
            "build",
        }
        for child in root.iterdir():
            if child.is_dir() and child.name.startswith("."):
                exclude_dirs.add(child.name)

        result = subprocess.run(
            [
                "cloc",
                "--json",
                "--quiet",
                "--exclude-dir",
                ",".join(sorted(exclude_dirs)),
                str(root),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0:
            cloc_data = json.loads(result.stdout)
            if "SUM" in cloc_data:
                file_count = cloc_data["SUM"].get("nFiles", 0)
                line_count = cloc_data["SUM"].get("code", 0)
                by_language: dict[str, dict[str, int]] = {}
                for language, stats in cloc_data.items():
                    if language == "SUM" or not isinstance(stats, dict):
                        continue
                    code_lines = stats.get("code", 0)
                    files = stats.get("nFiles", 0)
                    if code_lines or files:
                        by_language[language] = {
                            "files": files,
                            "code": code_lines,
                        }
                return file_count, line_count, by_language
    except FileNotFoundError:
        return 0, 0, {}
    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError, ValueError):
        return 0, 0, {}
    except Exception:
        return 0, 0, {}

    return 0, 0, {}


def get_main_dirs(root: Path) -> list[str]:
    """获取主要目录结构（排除常见排除目录）。

    返回: 主要目录列表
    """
    main_dirs = []
    exclude_dirs = {".git", "node_modules", "vendor", "__pycache__", ".venv", "venv", "dist", "build", ".idea", ".vscode"}

    for child in root.iterdir():
        if child.is_dir() and not child.name.startswith(".") and child.name not in exclude_dirs:
            main_dirs.append(child.name)

    return sorted(main_dirs)[:10]


# Common monorepo container directories
MONOREPO_DIRS = ["packages", "apps", "modules", "services", "libs"]


def detect_monorepo_packages(root: Path) -> list[Path]:
    """Detect monorepo package directories containing code.

    Checks for common monorepo container dirs (packages/, apps/, etc.)
    and npm/pnpm workspaces config. Returns sub-package directories.

    Returns: List of package root paths (e.g. [root/packages/cli, root/packages/nodes-base])
    """
    package_dirs: list[Path] = []
    seen: set[Path] = set()

    # Strategy 1: Check common monorepo container directories
    for mono_dir_name in MONOREPO_DIRS:
        mono_dir = root / mono_dir_name
        if not mono_dir.is_dir():
            continue
        for child in mono_dir.iterdir():
            if child.is_dir() and not child.name.startswith(".") and child not in seen:
                seen.add(child)
                package_dirs.append(child)

    # Strategy 2: Parse npm/pnpm workspaces from package.json
    if not package_dirs:
        pkg_json_path = root / "package.json"
        if pkg_json_path.exists():
            from .dependency import read_json_safe

            pkg_json = read_json_safe(pkg_json_path)
            workspaces = pkg_json.get("workspaces", [])
            if isinstance(workspaces, dict):
                workspaces = workspaces.get("packages", [])
            if isinstance(workspaces, list):
                for ws_pattern in workspaces:
                    for ws_path in root.glob(ws_pattern):
                        if ws_path.is_dir() and ws_path not in seen:
                            seen.add(ws_path)
                            package_dirs.append(ws_path)

    return sorted(package_dirs)


# Common test/non-production directory names
TEST_DIR_NAMES = {
    "test", "tests", "testing", "e2e", "e2e-tests",
    "__tests__", "spec", "specs", "benchmark", "benchmarks",
    "fixtures", "testdata", "test-data", "mocks",
    "playwright", "cypress", "jest",
}


def detect_test_dirs(root: Path) -> list[str]:
    """Detect test and non-production directories in the project.

    Scans root-level dirs and monorepo sub-packages for common test
    directory names. Returns relative paths for downstream filtering.

    Returns: List of relative path strings (e.g. ["tests/", "packages/testing/"])
    """
    test_dirs: list[str] = []
    seen: set[str] = set()

    def _add(rel: str) -> None:
        if rel not in seen:
            seen.add(rel)
            test_dirs.append(rel)

    # 1. Root-level test directories
    for child in root.iterdir():
        if child.is_dir() and child.name.lower() in TEST_DIR_NAMES:
            _add(child.name + "/")

    # 2. Monorepo sub-packages: package name matches or contains test dirs
    for pkg_dir in detect_monorepo_packages(root):
        pkg_rel = str(pkg_dir.relative_to(root))
        # Package itself is a test package
        if pkg_dir.name.lower() in TEST_DIR_NAMES:
            _add(pkg_rel + "/")
            continue
        # Check one level inside the package
        for child in pkg_dir.iterdir():
            if child.is_dir() and child.name.lower() in TEST_DIR_NAMES:
                _add(str(child.relative_to(root)) + "/")

    return sorted(test_dirs)


def resolve_search_paths(root: Path, code_dirs: list[str]) -> list[str]:
    """Resolve search paths for code scanning, with monorepo support.

    First checks root-level code_dirs. If none found, detects monorepo
    packages and checks code_dirs within each package. Falls back to
    root if nothing is found.

    Returns: List of absolute path strings suitable for ripgrep.
    """
    search_paths: list[str] = []

    # Check root-level code directories
    for code_dir in code_dirs:
        code_path = root / code_dir
        if code_path.exists() and code_path.is_dir():
            search_paths.append(str(code_path))

    # If no root-level dirs found, try monorepo packages
    if not search_paths:
        for pkg_dir in detect_monorepo_packages(root):
            pkg_has_match = False
            for code_dir in code_dirs:
                code_path = pkg_dir / code_dir
                if code_path.exists() and code_path.is_dir():
                    search_paths.append(str(code_path))
                    pkg_has_match = True
            # Add package root if it has no standard code_dirs
            if not pkg_has_match:
                search_paths.append(str(pkg_dir))

    if not search_paths:
        search_paths = [str(root)]

    return search_paths


def detect_framework_type(language: str | None, framework: str | None) -> str | None:
    """根据语言和框架确定框架类型（用于路由模式匹配）。

    返回: 框架类型字符串（用于查找路由模式）
    """
    if not language:
        return None

    if language == "JavaScript/TypeScript":
        if framework:
            fw_lower = framework.lower()
            if "express" in fw_lower:
                return "express"
            elif "koa" in fw_lower:
                return "koa"
            elif "fastify" in fw_lower:
                return "fastify"
            elif "nest" in fw_lower:
                return "nest"
            elif "hapi" in fw_lower:
                return "hapi"
    elif language == "Python":
        if framework:
            fw_lower = framework.lower()
            if "flask" in fw_lower:
                return "flask"
            elif "django" in fw_lower:
                return "django"
            elif "fastapi" in fw_lower:
                return "fastapi"
            elif "tornado" in fw_lower:
                return "tornado"
            elif "bottle" in fw_lower:
                return "bottle"
    elif language == "Java":
        if framework:
            fw_lower = framework.lower()
            if "spring" in fw_lower:
                return "spring-boot"
            elif "play" in fw_lower:
                return "play"
    elif language == "Go":
        if framework:
            fw_lower = framework.lower()
            if "gin" in fw_lower:
                return "gin"
            elif "echo" in fw_lower:
                return "echo"
            elif "chi" in fw_lower:
                return "chi"
            elif "fiber" in fw_lower:
                return "fiber"
        return "go-stdlib"
    elif language == "PHP":
        if framework:
            fw_lower = framework.lower()
            if "laravel" in fw_lower:
                return "laravel"
            elif "symfony" in fw_lower:
                return "symfony"
            elif "codeigniter" in fw_lower:
                return "codeigniter"
            elif "yii" in fw_lower:
                return "yii"
    elif language == ".NET":
        if framework and "aspnet" in framework.lower():
            return "aspnetcore"
    elif language == "Rust":
        if framework:
            fw_lower = framework.lower()
            if "actix" in fw_lower:
                return "actix"
            elif "rocket" in fw_lower:
                return "rocket"
            elif "warp" in fw_lower:
                return "warp"
    elif language == "Ruby":
        if framework:
            fw_lower = framework.lower()
            if "rails" in fw_lower:
                return "rails"
            elif "sinatra" in fw_lower:
                return "sinatra"
    elif language == "Scala":
        if framework:
            fw_lower = framework.lower()
            if "play" in fw_lower:
                return "play"
    if language in ("Java", "Scala") and framework and "ktor" in framework.lower():
        return "ktor"

    return None


def find_router_files_with_snippets(root: Path, language: str | None, framework: str | None) -> tuple[list[str], list[str]]:
    """根据框架类型查找路由文件并提取代码片段。

    返回: (文件列表, 代码片段列表)
    """
    router_files = []
    router_snippets = []

    # 确定框架类型
    framework_type = detect_framework_type(language, framework)
    if not framework_type:
        return [], []

    # 获取路由注册模式
    patterns = ROUTE_PATTERNS.get(framework_type, [])
    if not patterns:
        return [], []

    # 确定搜索目录
    code_dirs = ["src", "app", "server", "routes", "routers", "api", "controllers", "handlers", "ui", "frontend", "client"]
    if language == "Go":
        code_dirs.extend(["cmd", "internal", "pkg"])
    elif language == "Ruby":
        code_dirs.extend(["app", "config"])
    elif language == "Rust":
        code_dirs.extend(["src", "examples"])
    elif language == "Scala":
        code_dirs.extend(["app", "src"])

    # 使用 ripgrep 搜索
    search_paths = resolve_search_paths(root, code_dirs)
    for pattern in patterns:
        try:
            cmd = ["rg", "-n", "-C", "1", pattern] + search_paths

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,
            )

            if result.returncode == 0 and result.stdout.strip():
                for line in result.stdout.split("\n"):
                    if line.startswith("--"):
                        continue
                    if ":" in line:
                        parts = line.split(":", 2)
                        if len(parts) >= 3:
                            file_path = parts[0]
                            line_num = parts[1]
                            content = parts[2].strip()

                            try:
                                rel_path = str(Path(file_path).relative_to(root))
                            except ValueError:
                                rel_path = file_path

                            if rel_path not in router_files:
                                router_files.append(rel_path)

                            if content:
                                snippet = f"{rel_path}:{line_num}: {content}"
                                if snippet not in router_snippets:
                                    router_snippets.append(snippet)

                if len(router_files) >= 50:
                    break

        except (subprocess.TimeoutExpired, FileNotFoundError):
            continue
        except Exception:
            continue

    return router_files[:50], router_snippets


def find_entry_points(root: Path, language: str | None = None, framework: str | None = None) -> tuple[list[str], list[str], list[str], list[str]]:
    """查找入口文件和路由文件。

    返回: (入口文件列表, 路由文件列表, 路由代码片段列表, 前端入口文件列表)
    """
    entry_files = []
    frontend_entry_files = []

    # 查找主入口文件
    for entry_file in ENTRY_FILES:
        for path in root.rglob(entry_file):
            if path.is_file():
                rel_path = str(path.relative_to(root))
                entry_files.append(rel_path)
                break

    # 查找前端入口文件（在 ui/、frontend/、client/ 等目录中）
    for frontend_dir_name in FRONTEND_DIRS:
        frontend_dir = root / frontend_dir_name
        if not frontend_dir.is_dir():
            continue
        for entry_file in FRONTEND_ENTRY_FILES:
            for path in frontend_dir.rglob(entry_file):
                if path.is_file():
                    rel_path = str(path.relative_to(root))
                    frontend_entry_files.append(rel_path)
                    break

    # 根据框架查找路由文件和代码片段
    router_files, router_snippets = find_router_files_with_snippets(root, language, framework)

    return entry_files[:10], router_files, router_snippets, frontend_entry_files[:10]
