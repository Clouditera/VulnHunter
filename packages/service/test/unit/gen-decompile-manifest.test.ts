import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * gen-decompile-manifest.py (HALL-25 P0): deterministic .class → .java
 * mapping table for the platform viewer. The script is the ONLY manifest
 * writer — the agent never hand-authors JSON. Contract:
 *   argv: <jarOrExtractedDir> <decompiledRootDir> <manifestPath>
 *   - .class entries (relative to the jar/extraction root) are mapped by
 *     stripping `$` inner-class suffixes level by level until an existing
 *     .java under decompiledRoot matches;
 *   - multiple jars merge into one manifest (keyed by jar name);
 *   - re-running the same jar is idempotent (entries replaced, others kept);
 *   - the write is atomic (tmp file + rename).
 */

const repoRoot = join(import.meta.dirname, "../../../..");
const script = join(repoRoot, "worker-assets/gen-decompile-manifest.py");
const roots: string[] = [];

afterEach(() => {
  const pending = roots.splice(0, roots.length);
  for (const dir of pending) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gen-manifest-"));
  roots.push(dir);
  return dir;
}

function run(args: string[]) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8" });
}

interface RawManifestJar {
  name: string;
  decompiled_root: string;
  entries: Record<string, string>;
}
interface RawManifest {
  version: number;
  jars: RawManifestJar[];
}

function readManifest(path: string): RawManifest {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Build an extracted-jar-like directory: classFiles are relative paths. */
function makeExtractedJar(root: string, classFiles: string[]): string {
  const jarDir = join(root, "extracted", "app.war");
  for (const rel of classFiles) {
    const target = join(jarDir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    // .class files are binary; 0x00-heavy content is fine (never read back)
    writeFileSync(target, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00]));
  }
  return jarDir;
}

function makeDecompiled(root: string, javaFiles: string[]): string {
  const decDir = join(root, "src", ".vulnhunter-decompiled", "app.war");
  for (const rel of javaFiles) {
    const target = join(decDir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `// decompiled ${rel}\n`);
  }
  return decDir;
}

describe("gen-decompile-manifest.py (HALL-25 P0)", () => {
  it("maps plain and inner classes; strips $ level by level", () => {
    const root = tmpRoot();
    const jarDir = makeExtractedJar(root, [
      "WEB-INF/classes/com/foo/Bar.class",
      "WEB-INF/classes/com/foo/Bar$Inner.class",
      "WEB-INF/classes/com/foo/Bar$Inner$1.class",
    ]);
    const decDir = makeDecompiled(root, ["WEB-INF/classes/com/foo/Bar.java"]);

    const manifestPath = join(root, "manifest.json");
    const res = run([jarDir, decDir, manifestPath]);
    expect(res.status).toBe(0);

    const manifest = readManifest(manifestPath);
    expect(manifest.version).toBe(1);
    expect(manifest.jars).toHaveLength(1);
    const jar = manifest.jars[0];
    expect(jar.name).toBe("app.war");
    expect(jar.decompiled_root).toBe(".vulnhunter-decompiled/app.war");
    const entries = jar.entries as Record<string, string>;
    expect(Object.keys(entries)).toHaveLength(3);
    // every class variant maps to the same source file
    for (const key of [
      "WEB-INF/classes/com/foo/Bar.class",
      "WEB-INF/classes/com/foo/Bar$Inner.class",
      "WEB-INF/classes/com/foo/Bar$Inner$1.class",
    ]) {
      expect(entries[key]).toBe(".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java");
    }
  });

  it("omits classes with no decompiled counterpart (dependency classes)", () => {
    const root = tmpRoot();
    const jarDir = makeExtractedJar(root, [
      "WEB-INF/classes/com/foo/Bar.class",
      "WEB-INF/lib/dep/SomeDep.class",
    ]);
    const decDir = makeDecompiled(root, ["WEB-INF/classes/com/foo/Bar.java"]);

    const manifestPath = join(root, "manifest.json");
    expect(run([jarDir, decDir, manifestPath]).status).toBe(0);
    const entries = readManifest(manifestPath).jars[0].entries;
    expect(Object.keys(entries)).toEqual(["WEB-INF/classes/com/foo/Bar.class"]);
  });

  it("merges multiple jars into one manifest, keyed by jar name", () => {
    const root = tmpRoot();
    const jarA = makeExtractedJar(root, ["com/a/A.class"]);
    const jarB = makeExtractedJar(root, ["com/b/B.class"]);
    // the helper hardcodes the jar dir name app.war — rename to make two jars
    const dirA = join(root, "jars", "a.jar");
    mkdirSync(join(root, "jars"), { recursive: true });
    const dirB = join(root, "jars", "b.jar");
    rmSync(jarA, { recursive: true, force: true });
    rmSync(jarB, { recursive: true, force: true });
    mkdirSync(join(dirA, "com", "a"), { recursive: true });
    writeFileSync(join(dirA, "com", "a", "A.class"), "\x00\x01");
    mkdirSync(join(dirB, "com", "b"), { recursive: true });
    writeFileSync(join(dirB, "com", "b", "B.class"), "\x00\x01");

    const decA = join(root, "src", ".vulnhunter-decompiled", "a.jar");
    mkdirSync(join(decA, "com", "a"), { recursive: true });
    writeFileSync(join(decA, "com", "a", "A.java"), "// a\n");
    const decB = join(root, "src", ".vulnhunter-decompiled", "b.jar");
    mkdirSync(join(decB, "com", "b"), { recursive: true });
    writeFileSync(join(decB, "com", "b", "B.java"), "// b\n");

    const manifestPath = join(root, "manifest.json");
    expect(run([dirA, decA, manifestPath]).status).toBe(0);
    expect(run([dirB, decB, manifestPath]).status).toBe(0);

    const jars = readManifest(manifestPath).jars;
    expect(jars.map((j) => j.name).sort()).toEqual(["a.jar", "b.jar"]);
    expect(jars[0].entries).toEqual({
      "com/a/A.class": ".vulnhunter-decompiled/a.jar/com/a/A.java",
    });
    expect(jars[1].entries).toEqual({
      "com/b/B.class": ".vulnhunter-decompiled/b.jar/com/b/B.java",
    });
  });

  it("is idempotent: re-running the same jar replaces its entries without duplicating", () => {
    const root = tmpRoot();
    const jarDir = makeExtractedJar(root, ["com/foo/Bar.class"]);
    const decDir = makeDecompiled(root, ["com/foo/Bar.java"]);
    const manifestPath = join(root, "manifest.json");

    expect(run([jarDir, decDir, manifestPath]).status).toBe(0);
    expect(run([jarDir, decDir, manifestPath]).status).toBe(0);

    const manifest = readManifest(manifestPath);
    expect(manifest.jars).toHaveLength(1);
    expect(Object.keys(manifest.jars[0].entries)).toEqual(["com/foo/Bar.class"]);
  });

  it("accepts a real .jar/.war file (reads entries via zipfile), not just extracted dirs", () => {
    const root = tmpRoot();
    // build a minimal zip with one .class entry using python's zipfile
    const jarPath = join(root, "svc.war");
    const zres = spawnSync(
      "python3",
      [
        "-c",
        `
import zipfile
with zipfile.ZipFile(r"${jarPath}", "w") as z:
    z.writestr("WEB-INF/classes/svc/Ping.class", "\\x00\\xca\\xfe\\xba\\xbe")
    z.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\\n")
`,
      ],
      { encoding: "utf8" },
    );
    expect(zres.status).toBe(0);

    const decDir = join(root, "src", ".vulnhunter-decompiled", "svc.war");
    mkdirSync(join(decDir, "WEB-INF", "classes", "svc"), { recursive: true });
    writeFileSync(join(decDir, "WEB-INF", "classes", "svc", "Ping.java"), "// ping\n");

    const manifestPath = join(root, "manifest.json");
    expect(run([jarPath, decDir, manifestPath]).status).toBe(0);
    const jar = readManifest(manifestPath).jars[0];
    expect(jar.name).toBe("svc.war");
    expect(jar.entries).toEqual({
      "WEB-INF/classes/svc/Ping.class":
        ".vulnhunter-decompiled/svc.war/WEB-INF/classes/svc/Ping.java",
    });
  });

  it("keeps other jars' entries when one jar is regenerated (merge semantics)", () => {
    const root = tmpRoot();
    const jarDir = makeExtractedJar(root, ["com/foo/Bar.class"]);
    const decDir = makeDecompiled(root, ["com/foo/Bar.java"]);
    const manifestPath = join(root, "manifest.json");

    // pre-seed with another jar's entry (as if a previous invocation wrote it)
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        jars: [
          {
            name: "other.jar",
            decompiled_root: ".vulnhunter-decompiled/other.jar",
            entries: { "o/O.class": ".vulnhunter-decompiled/other.jar/o/O.java" },
          },
        ],
      }),
    );

    expect(run([jarDir, decDir, manifestPath]).status).toBe(0);
    const jars = readManifest(manifestPath).jars;
    expect(jars.map((j) => j.name).sort()).toEqual(["app.war", "other.jar"]);
  });

  it("overwrites a corrupt existing manifest instead of failing", () => {
    const root = tmpRoot();
    const jarDir = makeExtractedJar(root, ["com/foo/Bar.class"]);
    const decDir = makeDecompiled(root, ["com/foo/Bar.java"]);
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, "{corrupt json");

    expect(run([jarDir, decDir, manifestPath]).status).toBe(0);
    expect(readManifest(manifestPath).jars[0].name).toBe("app.war");
  });

  it("rejects bad argv with a nonzero exit", () => {
    const root = tmpRoot();
    expect(run([]).status).not.toBe(0);
    expect(run([join(root, "nope")]).status).not.toBe(0);
  });

  it("is world-readable so de-identified workers can regenerate it", () => {
    const root = tmpRoot();
    const jarDir = makeExtractedJar(root, ["com/foo/Bar.class"]);
    const decDir = makeDecompiled(root, ["com/foo/Bar.java"]);
    const manifestPath = join(root, "manifest.json");
    expect(run([jarDir, decDir, manifestPath]).status).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);
    // 0644-ish: owner rw, others r — no execute bits
    const mode = Number.parseInt(
      spawnSync("stat", ["-c", "%a", manifestPath], { encoding: "utf8" }).stdout.trim(),
      8,
    );
    expect(mode & 0o111).toBe(0);
    expect(mode & 0o044).toBe(0o044);
    chmodSync(manifestPath, 0o644); // keep tmp cleanup happy on umask-strict hosts
  });
});
