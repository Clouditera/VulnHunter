#!/usr/bin/env python3
"""Generate the decompile manifest for jar/war targets (HALL-25 P0).

The manifest is a long-lived contract between the preprocessing skill and
the platform viewer: a deterministic `.class` → `.java` mapping produced at
decompile time, so the viewer never has to guess. The agent never
hand-authors this JSON — this script is the single writer.

Contract (schema v1, see HALL-25):
  argv: <jarOrExtractedDir> <decompiledRootDir> <manifestPath>
  {
    "version": 1,
    "jars": [
      {
        "name": "app.war",
        "decompiled_root": ".vulnhunter-decompiled/app.war",
        "entries": {
          "WEB-INF/classes/com/foo/Bar.class":
              ".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java"
        }
      }
    ]
  }

Rules:
  - entries keys are .class paths relative to the jar/extraction root;
  - inner classes resolve by stripping `$` suffix segments level by level
    (`Bar$Inner$1.class` → `Bar$Inner.class` → `Bar.class`) until an
    existing .java under decompiledRootDir matches;
  - classes without a decompiled counterpart are omitted (dependency code
    was never decompiled — the viewer shows them as plain binary);
  - multiple jars merge into one manifest keyed by jar name; re-running a
    jar replaces only its own entries (idempotent);
  - the manifest is written atomically (tmp file + os.replace).
"""

import argparse
import json
import os
import sys
import tempfile
import zipfile

SUPPORTED_VERSION = 1


def fail(msg: str) -> int:
    print(f"gen-decompile-manifest: {msg}", file=sys.stderr)
    return 2


def list_class_entries(jar_or_dir: str) -> list[str]:
    """All .class paths inside a jar/war file or an extracted directory,
    relative to the jar/extraction root."""
    if os.path.isfile(jar_or_dir):
        with zipfile.ZipFile(jar_or_dir) as zf:
            return [n for n in zf.namelist() if n.endswith(".class")]
    entries: list[str] = []
    for dirpath, _dirnames, filenames in os.walk(jar_or_dir):
        for fname in filenames:
            if fname.endswith(".class"):
                full = os.path.join(dirpath, fname)
                entries.append(os.path.relpath(full, jar_or_dir).replace(os.sep, "/"))
    entries.sort()
    return entries


def candidate_java_paths(class_rel: str) -> list[str]:
    """.java candidates for one .class path, most specific first.

    `com/foo/Bar$Inner$1.class` yields `com/foo/Bar$Inner$1.java`,
    `com/foo/Bar$Inner.java`, `com/foo/Bar.java` — the inner-class suffix
    is stripped one `$` segment at a time.
    """
    base = class_rel[: -len(".class")]
    candidates = [f"{base}.java"]
    while "$" in base:
        base = base.rsplit("$", 1)[0]
        candidates.append(f"{base}.java")
    return candidates


def resolve_entry(class_rel: str, decompiled_root: str) -> str | None:
    """First candidate .java that exists under decompiled_root, else None."""
    for java_rel in candidate_java_paths(class_rel):
        if os.path.isfile(os.path.join(decompiled_root, java_rel)):
            return java_rel
    return None


def load_existing(manifest_path: str) -> dict:
    """Parse the existing manifest; corrupt/unknown-version → fresh v1 doc
    (the writer is authoritative, stale data must never wedge the script)."""
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {"version": SUPPORTED_VERSION, "jars": []}
    if (
        not isinstance(doc, dict)
        or doc.get("version") != SUPPORTED_VERSION
        or not isinstance(doc.get("jars"), list)
    ):
        return {"version": SUPPORTED_VERSION, "jars": []}
    return doc


def atomic_write_json(manifest_path: str, doc: dict) -> None:
    """Write JSON via tmp file + rename so readers never see a torn file."""
    manifest_dir = os.path.dirname(os.path.abspath(manifest_path)) or "."
    fd, tmp_path = tempfile.mkstemp(dir=manifest_dir, prefix=".manifest-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.chmod(tmp_path, 0o644)  # world-readable for de-identified workers
        os.replace(tmp_path, manifest_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def decompiled_root_rel(decompiled_root: str) -> str:
    """decompiled_root as a src/-relative path: everything from the
    `.vulnhunter-decompiled` segment on (e.g. `.vulnhunter-decompiled/app.war`).
    Falls back to the basename when the convention segment is absent."""
    parts = os.path.normpath(decompiled_root).replace(os.sep, "/").split("/")
    if ".vulnhunter-decompiled" in parts:
        idx = len(parts) - 1 - parts[::-1].index(".vulnhunter-decompiled")
        return "/".join(parts[idx:])
    return parts[-1]


def build_entries(jar_or_dir: str, decompiled_root: str) -> dict[str, str]:
    """entries map for one jar: class path (jar-relative) → .java path
    (relative to src/, i.e. `<decompiled_root_rel>/<java_rel>`)."""
    root_rel = decompiled_root_rel(decompiled_root)
    entries: dict[str, str] = {}
    for class_rel in list_class_entries(jar_or_dir):
        java_rel = resolve_entry(class_rel, decompiled_root)
        if java_rel is not None:
            entries[class_rel] = f"{root_rel}/{java_rel}"
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate/merge the decompile manifest for one jar (HALL-25).",
    )
    parser.add_argument("jar_or_dir", help="jar/war file or its extracted directory")
    parser.add_argument("decompiled_root", help="decompiled output dir for this jar (under src/.vulnhunter-decompiled/<jar>/)")
    parser.add_argument("manifest_path", help="manifest.json path (shared across jars)")
    args = parser.parse_args()

    if not os.path.exists(args.jar_or_dir):
        return fail(f"jar or extracted dir not found: {args.jar_or_dir}")
    if not os.path.isdir(args.decompiled_root):
        return fail(f"decompiled root is not a directory: {args.decompiled_root}")

    jar_name = os.path.basename(os.path.normpath(args.jar_or_dir))
    root_rel = decompiled_root_rel(args.decompiled_root)
    entries = build_entries(args.jar_or_dir, args.decompiled_root)

    doc = load_existing(args.manifest_path)
    jar_block = {
        "name": jar_name,
        "decompiled_root": root_rel,
        "entries": entries,
    }
    doc["jars"] = [j for j in doc["jars"] if isinstance(j, dict) and j.get("name") != jar_name]
    doc["jars"].append(jar_block)
    doc["jars"].sort(key=lambda j: str(j.get("name", "")))

    atomic_write_json(args.manifest_path, doc)
    print(f"manifest updated: {args.manifest_path} (jar={jar_name}, entries={len(entries)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
