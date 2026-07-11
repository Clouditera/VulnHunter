import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";

export const SOURCE_MANIFEST_SCHEMA_VERSION = "source-manifest/v1" as const;

export interface SourceManifestLimits {
  maxEntries: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxSingleFileBytes: number;
  maxDepth: number;
  maxIndexedMarkers: number;
}

export const DEFAULT_SOURCE_MANIFEST_LIMITS: SourceManifestLimits = {
  maxEntries: 20_000,
  maxFiles: 10_000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxSingleFileBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxIndexedMarkers: 256,
};

export type SourceManifestSourceKind = "archive" | "git" | "directory";

export interface SourceManifestEntry {
  path: string;
  type: "directory" | "file";
  size: number;
  sha256: string | null;
  extension: string | null;
}

export interface SourceManifestMarker {
  path: string;
  kind: "build" | "dependency" | "readme" | "container" | "workspace";
  name: string;
  size: number;
  sha256: string;
}

export interface SourceManifestSignal {
  kind: "submodule" | "generated_source" | "patch" | "test_corpus" | "vendor_fragment" | "multi_root";
  paths: string[];
  count: number;
}

export interface SourceManifest {
  schema_version: typeof SOURCE_MANIFEST_SCHEMA_VERSION;
  source: {
    kind: SourceManifestSourceKind;
    identity_sha256: string;
  };
  root_candidates: Array<{ path: string; marker_paths: string[] }>;
  tree: SourceManifestEntry[];
  statistics: {
    files_observed: number;
    directories_observed: number;
    bytes_observed: number;
    bytes_hashed: number;
    excluded_sensitive_files: number;
    extensions: Array<{ extension: string; files: number; bytes: number }>;
    languages: Array<{ language: string; files: number; bytes: number }>;
  };
  markers: SourceManifestMarker[];
  signals: SourceManifestSignal[];
  limits: SourceManifestLimits;
  truncation: {
    truncated: boolean;
    reasons: string[];
  };
  warnings: string[];
}

export class SourceManifestError extends Error {
  constructor(public readonly code: "ERR_SOURCE_ROOT_UNSAFE" | "ERR_SOURCE_PATH_INVALID" | "ERR_SOURCE_ENTRY_UNSAFE") {
    super(code);
    this.name = "SourceManifestError";
  }
}

const MARKERS = new Map<string, { kind: SourceManifestMarker["kind"]; name: string }>([
  ["readme", { kind: "readme", name: "readme" }],
  ["readme.md", { kind: "readme", name: "readme" }],
  ["readme.rst", { kind: "readme", name: "readme" }],
  ["package.json", { kind: "dependency", name: "npm_package" }],
  ["pnpm-workspace.yaml", { kind: "workspace", name: "pnpm_workspace" }],
  ["pnpm-lock.yaml", { kind: "dependency", name: "pnpm_lock" }],
  ["yarn.lock", { kind: "dependency", name: "yarn_lock" }],
  ["package-lock.json", { kind: "dependency", name: "npm_lock" }],
  ["go.mod", { kind: "dependency", name: "go_module" }],
  ["cargo.toml", { kind: "dependency", name: "cargo_manifest" }],
  ["cargo.lock", { kind: "dependency", name: "cargo_lock" }],
  ["pyproject.toml", { kind: "dependency", name: "python_project" }],
  ["requirements.txt", { kind: "dependency", name: "python_requirements" }],
  ["pom.xml", { kind: "build", name: "maven" }],
  ["build.gradle", { kind: "build", name: "gradle" }],
  ["build.gradle.kts", { kind: "build", name: "gradle" }],
  ["cmakelists.txt", { kind: "build", name: "cmake" }],
  ["makefile", { kind: "build", name: "make" }],
  ["configure", { kind: "build", name: "autoconf_configure" }],
  ["meson.build", { kind: "build", name: "meson" }],
  ["dockerfile", { kind: "container", name: "dockerfile" }],
  ["docker-compose.yml", { kind: "container", name: "compose" }],
  ["docker-compose.yaml", { kind: "container", name: "compose" }],
  ["compose.yml", { kind: "container", name: "compose" }],
  ["compose.yaml", { kind: "container", name: "compose" }],
  [".gitmodules", { kind: "workspace", name: "git_submodules" }],
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C", ".h": "C/C++ Header", ".cc": "C++", ".cpp": "C++", ".cxx": "C++",
  ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
  ".py": "Python", ".rb": "Ruby", ".php": "PHP", ".js": "JavaScript", ".jsx": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".cs": "C#", ".swift": "Swift", ".m": "Objective-C",
  ".mm": "Objective-C++", ".scala": "Scala", ".sh": "Shell", ".sol": "Solidity", ".zig": "Zig",
};

const SENSITIVE_BASENAMES = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateLimits(limits: SourceManifestLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Source manifest limits must be positive safe integers");
  }
}

function relativePath(parent: string, name: string): string {
  const path = parent === "." ? name : `${parent}/${name}`;
  if (path.startsWith("/") || path === ".." || path.startsWith("../") || CONTROL_OR_BACKSLASH.test(path)) {
    throw new SourceManifestError("ERR_SOURCE_PATH_INVALID");
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized.split("/").includes("..")) {
    throw new SourceManifestError("ERR_SOURCE_PATH_INVALID");
  }
  return path;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function extensionOf(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return ext || null;
}

function isSensitivePath(path: string): boolean {
  return path.split("/").some((part) => SENSITIVE_BASENAMES.test(part));
}

function hashOpenFile(fd: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count < 1) throw new SourceManifestError("ERR_SOURCE_ENTRY_UNSAFE");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest("hex");
}

function markerFor(path: string): { kind: SourceManifestMarker["kind"]; name: string } | undefined {
  return MARKERS.get(posix.basename(path).toLowerCase());
}

function signalPaths(tree: SourceManifestEntry[], markers: SourceManifestMarker[]): SourceManifestSignal[] {
  const filePaths = tree.filter((entry) => entry.type === "file").map((entry) => entry.path);
  const directoryPaths = tree.filter((entry) => entry.type === "directory").map((entry) => entry.path);
  const specs: Array<[SourceManifestSignal["kind"], string[]]> = [
    ["submodule", markers.filter((m) => m.name === "git_submodules").map((m) => m.path)],
    ["generated_source", filePaths.filter((p) => /(?:^|\/)(?:generated|gen)(?:\/|$)|\.(?:pb|generated)\.[^.]+$/i.test(p))],
    ["patch", filePaths.filter((p) => /\.(?:patch|diff)$/i.test(p))],
    ["test_corpus", [...filePaths.filter((p) => /\.(?:sarif)$/i.test(p)), ...directoryPaths.filter((p) => /(?:^|\/)(?:test|tests|corpus|fixtures?)$/i.test(p))]],
    ["vendor_fragment", directoryPaths.filter((p) => /(?:^|\/)(?:vendor|third_party|third-party)$/i.test(p))],
  ];
  return specs
    .map(([kind, paths]) => ({ kind, paths: [...new Set(paths)].sort(), count: new Set(paths).size }))
    .filter((signal) => signal.count > 0);
}

function rootCandidates(markers: SourceManifestMarker[]): Array<{ path: string; marker_paths: string[] }> {
  const byRoot = new Map<string, string[]>();
  for (const marker of markers) {
    const parts = marker.path.split("/");
    const root = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
    if (root !== "." && root.split("/").length > 2) continue;
    const values = byRoot.get(root) ?? [];
    values.push(marker.path);
    byRoot.set(root, values);
  }
  if (byRoot.size === 0) byRoot.set(".", []);
  return [...byRoot.entries()]
    .map(([path, markerPaths]) => ({ path, marker_paths: markerPaths.sort() }))
    .sort((a, b) => compareText(a.path, b.path));
}

export function generateSourceManifest(
  sourceRoot: string,
  options: { sourceKind?: SourceManifestSourceKind; limits?: Partial<SourceManifestLimits> } = {},
): SourceManifest {
  const limits = { ...DEFAULT_SOURCE_MANIFEST_LIMITS, ...options.limits };
  validateLimits(limits);

  let rootFd: number;
  try {
    rootFd = openSync(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new SourceManifestError("ERR_SOURCE_ROOT_UNSAFE");
  }

  const tree: SourceManifestEntry[] = [];
  const markers: SourceManifestMarker[] = [];
  const identityParts: string[] = [];
  const truncationReasons = new Set<string>();
  const warnings = new Set<string>();
  const extensions = new Map<string, { files: number; bytes: number }>();
  let entriesObserved = 0;
  let filesObserved = 0;
  let directoriesObserved = 1;
  let bytesObserved = 0;
  let bytesHashed = 0;
  let excludedSensitiveFiles = 0;
  let stopped = false;

  try {
    let stableRoot: string;
    try {
      stableRoot = realpathSync(`/proc/self/fd/${rootFd}`);
    } catch {
      throw new SourceManifestError("ERR_SOURCE_ROOT_UNSAFE");
    }

    const walk = (directoryFdPath: string, relativeDirectory: string, depth: number): void => {
      if (stopped) return;
      if (depth > limits.maxDepth) {
        truncationReasons.add("max_depth");
        return;
      }
      const names = readdirSync(directoryFdPath).sort(compareText);
      for (const name of names) {
        if (entriesObserved >= limits.maxEntries) {
          truncationReasons.add("max_entries");
          stopped = true;
          return;
        }
        const path = relativePath(relativeDirectory, name);
        entriesObserved++;
        const openPath = join(directoryFdPath, name);
        let fd: number;
        try {
          fd = openSync(openPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch {
          throw new SourceManifestError("ERR_SOURCE_ENTRY_UNSAFE");
        }
        try {
          const stat = fstatSync(fd);
          let actual: string;
          try {
            actual = realpathSync(`/proc/self/fd/${fd}`);
          } catch {
            throw new SourceManifestError("ERR_SOURCE_ENTRY_UNSAFE");
          }
          if (!isWithin(stableRoot, actual)) throw new SourceManifestError("ERR_SOURCE_ENTRY_UNSAFE");

          if (stat.isDirectory()) {
            directoriesObserved++;
            tree.push({ path, type: "directory", size: 0, sha256: null, extension: null });
            identityParts.push(`d\0${path}`);
            walk(`/proc/self/fd/${fd}`, path, depth + 1);
            if (stopped) return;
            continue;
          }
          if (!stat.isFile() || stat.nlink !== 1) throw new SourceManifestError("ERR_SOURCE_ENTRY_UNSAFE");
          if (filesObserved >= limits.maxFiles) {
            truncationReasons.add("max_files");
            stopped = true;
            return;
          }

          filesObserved++;
          bytesObserved += stat.size;
          if (isSensitivePath(path)) {
            excludedSensitiveFiles++;
            warnings.add("sensitive_paths_excluded");
            let sensitiveHash = "unhashed";
            if (stat.size <= limits.maxSingleFileBytes && bytesHashed + stat.size <= limits.maxTotalBytes) {
              sensitiveHash = hashOpenFile(fd, stat.size);
              bytesHashed += stat.size;
            } else {
              truncationReasons.add(stat.size > limits.maxSingleFileBytes ? "max_single_file_bytes" : "max_total_bytes");
            }
            identityParts.push(`s\0${digest(path)}\0${stat.size}\0${sensitiveHash}`);
            continue;
          }

          const extension = extensionOf(path);
          if (extension) {
            const current = extensions.get(extension) ?? { files: 0, bytes: 0 };
            current.files++;
            current.bytes += stat.size;
            extensions.set(extension, current);
          }

          let sha256: string | null = null;
          if (stat.size > limits.maxSingleFileBytes) {
            truncationReasons.add("max_single_file_bytes");
          } else if (bytesHashed + stat.size > limits.maxTotalBytes) {
            truncationReasons.add("max_total_bytes");
          } else {
            sha256 = hashOpenFile(fd, stat.size);
            bytesHashed += stat.size;
          }
          tree.push({ path, type: "file", size: stat.size, sha256, extension });
          identityParts.push(`f\0${path}\0${stat.size}\0${sha256 ?? "unhashed"}`);

          const marker = markerFor(path);
          if (marker) {
            if (sha256 && markers.length < limits.maxIndexedMarkers) {
              markers.push({ path, ...marker, size: stat.size, sha256 });
            } else if (markers.length >= limits.maxIndexedMarkers) {
              truncationReasons.add("max_indexed_markers");
            } else {
              warnings.add("marker_not_hashed_due_to_limits");
            }
          }
        } finally {
          closeSync(fd);
        }
      }
    };

    walk(`/proc/self/fd/${rootFd}`, ".", 1);
  } finally {
    closeSync(rootFd);
  }

  tree.sort((a, b) => compareText(a.path, b.path) || compareText(a.type, b.type));
  markers.sort((a, b) => compareText(a.path, b.path));
  const roots = rootCandidates(markers);
  const signals = signalPaths(tree, markers);
  if (roots.length > 1) signals.push({ kind: "multi_root", paths: roots.map((root) => root.path), count: roots.length });
  signals.sort((a, b) => compareText(a.kind, b.kind));

  const extensionStats = [...extensions.entries()]
    .map(([extension, value]) => ({ extension, ...value }))
    .sort((a, b) => compareText(a.extension, b.extension));
  const languageMap = new Map<string, { files: number; bytes: number }>();
  for (const item of extensionStats) {
    const language = LANGUAGE_BY_EXTENSION[item.extension];
    if (!language) continue;
    const current = languageMap.get(language) ?? { files: 0, bytes: 0 };
    current.files += item.files;
    current.bytes += item.bytes;
    languageMap.set(language, current);
  }

  return {
    schema_version: SOURCE_MANIFEST_SCHEMA_VERSION,
    source: {
      kind: options.sourceKind ?? "directory",
      identity_sha256: digest(identityParts.sort().join("\n")),
    },
    root_candidates: roots,
    tree,
    statistics: {
      files_observed: filesObserved,
      directories_observed: directoriesObserved,
      bytes_observed: bytesObserved,
      bytes_hashed: bytesHashed,
      excluded_sensitive_files: excludedSensitiveFiles,
      extensions: extensionStats,
      languages: [...languageMap.entries()]
        .map(([language, value]) => ({ language, ...value }))
        .sort((a, b) => compareText(a.language, b.language)),
    },
    markers,
    signals,
    limits,
    truncation: {
      truncated: truncationReasons.size > 0,
      reasons: [...truncationReasons].sort(),
    },
    warnings: [...warnings].sort(),
  };
}
