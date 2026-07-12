#!/usr/bin/env python3
"""Prepare and verify immutable business artifacts around timeout finalization."""

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

import yaml

MAX_ENTRIES = 20_000
MAX_HASH_BYTES = 256 * 1024 * 1024
REPORT_FILES = {"completion.yaml", "audit-report.yaml", "summary.md"}
SNAPSHOT_NAME = "snapshot.json"
INVENTORY_NAME = "inventory.json"


class GateError(RuntimeError):
    pass


def atomic_private_json(directory: Path, name: str, value: object) -> None:
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temp = directory / f".{name}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, directory / name)
    dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)


def open_dir(path: Path) -> int:
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def safe_control(path: Path, out_dir: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Open the configured path itself with O_NOFOLLOW before resolving it so a
    # stale/swap symlink cannot redirect cleanup or trusted metadata writes.
    fd = open_dir(path)
    try:
        os.fchmod(fd, 0o700)
        resolved = Path(os.readlink(f"/proc/self/fd/{fd}"))
    finally:
        os.close(fd)
    out_resolved = out_dir.resolve(strict=True)
    if resolved == out_resolved or out_resolved in resolved.parents or resolved in out_resolved.parents:
        raise GateError("control and output directories must be disjoint")
    return resolved


def hash_file(parent_fd: int, name: str, expected: os.stat_result) -> str:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        actual = os.fstat(fd)
        if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or (actual.st_dev, actual.st_ino, actual.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
            raise GateError("unsafe or changed artifact file")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 64 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)
    finally:
        os.close(fd)


def snapshot(out_dir: Path) -> dict:
    root_fd = open_dir(out_dir)
    entries: list[dict] = []
    total_bytes = 0

    def walk(dir_fd: int, prefix: str) -> None:
        nonlocal total_bytes
        for name in sorted(os.listdir(dir_fd)):
            if "/" in name or name in (".", ".."):
                raise GateError("invalid artifact name")
            rel = name if not prefix else f"{prefix}/{name}"
            if not prefix and name in (".youngflow", "report"):
                continue
            info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                entries.append({"path": rel, "type": "directory", "size": 0})
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
                try:
                    walk(child, rel)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink != 1:
                    raise GateError(f"hardlinked artifact rejected: {rel}")
                total_bytes += info.st_size
                if total_bytes > MAX_HASH_BYTES:
                    raise GateError("artifact hash byte limit exceeded")
                entries.append({"path": rel, "type": "file", "size": info.st_size, "sha256": hash_file(dir_fd, name, info)})
            else:
                raise GateError(f"special artifact rejected: {rel}")
            if len(entries) > MAX_ENTRIES:
                raise GateError("artifact entry limit exceeded")

    try:
        walk(root_fd, "")
    finally:
        os.close(root_fd)
    result = {"schema_version": "timeout-finalize-snapshot/v1", "entries": entries, "total_file_bytes": total_bytes}
    result["snapshot_sha256"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return result


def remove_stale_reports(out_dir: Path) -> None:
    root_fd = open_dir(out_dir)
    try:
        try:
            report_fd = os.open("report", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except FileNotFoundError:
            return
        try:
            for name in REPORT_FILES:
                try:
                    info = os.stat(name, dir_fd=report_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise GateError(f"unsafe stale report: {name}")
                os.unlink(name, dir_fd=report_fd)
        finally:
            os.close(report_fd)
    finally:
        os.close(root_fd)


def prepare(args: argparse.Namespace) -> None:
    out_dir = Path(args.out_dir).resolve(strict=True)
    control = safe_control(Path(args.control_dir), out_dir)
    remove_stale_reports(out_dir)
    snap = snapshot(out_dir)
    inventory = {
        "schema_version": "timeout-finalize-inventory/v1",
        "analysis_limit_seconds": args.analysis_limit_seconds,
        "artifacts": [entry["path"] for entry in snap["entries"] if entry["type"] == "file"],
        "required_outputs": [f"report/{name}" for name in sorted(REPORT_FILES)],
        "business_snapshot_sha256": snap["snapshot_sha256"],
    }
    atomic_private_json(control, SNAPSHOT_NAME, snap)
    atomic_private_json(control, INVENTORY_NAME, inventory)
    print(json.dumps({"ok": True, "entries": len(snap["entries"]), "business_snapshot_sha256": snap["snapshot_sha256"]}, separators=(",", ":")))


def read_private_json(path: Path) -> object:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 8 * 1024 * 1024:
            raise GateError("unsafe snapshot metadata")
        data = b""
        while len(data) < info.st_size:
            chunk = os.read(fd, info.st_size - len(data))
            if not chunk:
                break
            data += chunk
        return json.loads(data)
    finally:
        os.close(fd)


def require_keys(value: object, required: set[str], allowed: set[str], label: str) -> dict:
    if not isinstance(value, dict) or not required.issubset(value) or not set(value).issubset(allowed):
        raise GateError(f"{label} keys do not match schema")
    return value


def require_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GateError(f"{label} must be non-empty text")
    return value


def validate_audit_report(value: object) -> set[str]:
    report = require_keys(value, {"report_version", "target", "summary", "findings"}, {
        "report_version", "target", "summary", "knowledge_summary", "findings", "risks", "limitations", "notes"
    }, "audit report")
    require_text(report["report_version"], "report_version")
    target = require_keys(report["target"], {"project_name", "project_root"}, {"project_name", "project_root", "language", "framework"}, "target")
    require_text(target["project_name"], "project_name")
    if target["project_root"] != ".":
        raise GateError("timeout report project_root must be submission-relative dot")
    for key in ("language", "framework"):
        if key in target:
            require_text(target[key], key)
    summary_required = {"total_hypotheses", "done_hypotheses", "pending_hypotheses", "confirmed_findings", "refuted_hypotheses"}
    summary_allowed = summary_required | {"risk_findings", "overall_risk"}
    summary = require_keys(report["summary"], summary_required, summary_allowed, "summary")
    for key in summary_required | {"risk_findings"}:
        if key in summary and (not isinstance(summary[key], int) or isinstance(summary[key], bool) or summary[key] < 0):
            raise GateError(f"summary.{key} must be a nonnegative integer")
    if "overall_risk" in summary and summary["overall_risk"] not in {"critical", "high", "medium", "low", "info"}:
        raise GateError("summary.overall_risk is invalid")
    finding_required = {"id", "title", "severity", "vulnerability_type", "location"}
    finding_allowed = finding_required | {"hypothesis_id", "remediation"}
    risk_required = {"id", "title", "location"}
    risk_allowed = risk_required | {"hypothesis_id", "note"}
    identifier = re.compile(r"^BUG-R\d+(-[A-Z]\d+)+-H\d+$")
    hypothesis = re.compile(r"^HYP-R\d+(-[A-Z]\d+)+-H\d+$")
    reported_finding_ids: set[str] = set()
    for label, items, required, allowed in (
        ("finding", report["findings"], finding_required, finding_allowed),
        ("risk", report.get("risks", []), risk_required, risk_allowed),
    ):
        if not isinstance(items, list):
            raise GateError(f"{label}s must be an array")
        for item in items:
            entry = require_keys(item, required, allowed, label)
            if not identifier.fullmatch(require_text(entry["id"], f"{label}.id")):
                raise GateError(f"{label}.id is invalid")
            if label == "finding":
                reported_finding_ids.add(entry["id"])
            if "hypothesis_id" in entry and not hypothesis.fullmatch(require_text(entry["hypothesis_id"], f"{label}.hypothesis_id")):
                raise GateError(f"{label}.hypothesis_id is invalid")
            for key in required - {"id"} | ({"remediation"} if "remediation" in entry else set()) | ({"note"} if "note" in entry else set()):
                require_text(entry[key], f"{label}.{key}")
            if "severity" in entry and entry["severity"] not in {"critical", "high", "medium", "low", "info"}:
                raise GateError("finding.severity is invalid")
    if "knowledge_summary" in report:
        require_text(report["knowledge_summary"], "knowledge_summary")
    if "limitations" in report and (not isinstance(report["limitations"], list) or any(not isinstance(item, str) for item in report["limitations"])):
        raise GateError("limitations must be a text array")
    if "notes" in report:
        require_text(report["notes"], "notes")
    return reported_finding_ids


def verify_reports(out_dir: Path, business_snapshot: dict) -> None:
    report = out_dir / "report"
    fd = open_dir(report)
    try:
        names = set(os.listdir(fd))
        if names != REPORT_FILES:
            raise GateError(f"report output set mismatch: {sorted(names)}")
        for name in names:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size < 1:
                raise GateError(f"unsafe report output: {name}")
        contents: dict[str, bytes] = {}
        for name, limit in (("completion.yaml", 64 * 1024), ("audit-report.yaml", 2 * 1024 * 1024), ("summary.md", 2 * 1024 * 1024)):
            file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                file_info = os.fstat(file_fd)
                if file_info.st_size > limit:
                    raise GateError(f"{name} too large")
                contents[name] = os.read(file_fd, file_info.st_size)
            finally:
                os.close(file_fd)

    finally:
        os.close(fd)
    value = yaml.safe_load(contents["completion.yaml"].decode("utf-8", errors="strict"))
    if not isinstance(value, dict) or set(value) != {"status", "reason"} or value.get("status") != "incomplete" or not isinstance(value.get("reason"), str):
        raise GateError("timeout completion must be exact incomplete declaration")
    reason = value["reason"].strip()
    if not reason or not re.search(r"(?:时长|时间上限|time\s*limit|time\s*budget|deadline)", reason, re.I):
        raise GateError("timeout completion reason must identify the time limit")
    audit_report = yaml.safe_load(contents["audit-report.yaml"].decode("utf-8", errors="strict"))
    reported_ids = validate_audit_report(audit_report)
    existing_ids: set[str] = set()
    for entry in business_snapshot.get("entries", []):
        path = entry.get("path", "") if isinstance(entry, dict) else ""
        match = re.fullmatch(r"findings/(BUG-[^/]+)/report\.yaml", path) or re.fullmatch(r"findings/(BUG-[^/]+)\.ya?ml", path)
        if match:
            existing_ids.add(match.group(1))
    if not reported_ids.issubset(existing_ids):
        raise GateError(f"audit report contains findings absent from protected artifacts: {sorted(reported_ids - existing_ids)[:3]}")
    if not contents["summary.md"].decode("utf-8", errors="strict").strip():
        raise GateError("summary.md must not be empty")


def verify(args: argparse.Namespace) -> None:
    out_dir = Path(args.out_dir).resolve(strict=True)
    control = safe_control(Path(args.control_dir), out_dir)
    before = read_private_json(control / SNAPSHOT_NAME)
    after = snapshot(out_dir)
    if before != after:
        before_entries = {entry["path"]: entry for entry in before.get("entries", [])} if isinstance(before, dict) else {}
        after_entries = {entry["path"]: entry for entry in after["entries"]}
        changed = sorted(path for path in set(before_entries) | set(after_entries) if before_entries.get(path) != after_entries.get(path))[:3]
        raise GateError(f"protected business artifacts changed during finalization: {changed}")
    verify_reports(out_dir, before)
    print(json.dumps({"ok": True, "business_snapshot_sha256": after["snapshot_sha256"]}, separators=(",", ":")))


def cleanup(args: argparse.Namespace) -> None:
    control = Path(args.control_dir)
    if control.exists() or control.is_symlink():
        fd = open_dir(control)
        try:
            for name in os.listdir(fd):
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise GateError("unsafe control entry")
                os.unlink(name, dir_fd=fd)
        finally:
            os.close(fd)
        os.rmdir(control)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--out-dir", required=True)
    prep.add_argument("--control-dir", required=True)
    prep.add_argument("--analysis-limit-seconds", type=int, required=True)
    check = sub.add_parser("verify")
    check.add_argument("--out-dir", required=True)
    check.add_argument("--control-dir", required=True)
    clean = sub.add_parser("cleanup")
    clean.add_argument("--control-dir", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            if args.analysis_limit_seconds < 1:
                raise GateError("invalid analysis limit")
            prepare(args)
        elif args.command == "verify":
            verify(args)
        else:
            cleanup(args)
        return 0
    except (GateError, OSError, ValueError, UnicodeError, yaml.YAMLError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:240]}, separators=(",", ":")), file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
