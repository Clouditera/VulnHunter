#!/usr/bin/python3
import json, os, stat, sys

MAX_BYTES = 4096
ALLOWED_KEYS = {"project_complete", "sandbox_type", "reason"}
ALLOWED_REASONS = {"complete", "partial_source", "no_compatible_sandbox"}

def fail(message: str) -> None:
    print(f"[prepare] invalid result: {message}", file=sys.stderr)
    raise SystemExit(4)

def load_unique(path: str):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                fail("duplicate field")
            out[key] = value
        return out
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle, object_pairs_hook=pairs)
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail("json")

def visible_profiles(path: str | None) -> set[str]:
    if not path:
        return set()
    try:
        raw = json.load(open(path, "r", encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail("profile snapshot")
    if not isinstance(raw, list):
        fail("profile snapshot")
    result = set()
    for item in raw:
        if not isinstance(item, dict) or set(item) - {"profile_id", "capabilities", "available"}:
            fail("profile snapshot")
        profile = item.get("profile_id")
        if not isinstance(profile, str) or not profile or len(profile) > 128:
            fail("profile snapshot")
        if item.get("available", True) is True:
            result.add(profile)
    return result

def main() -> None:
    if len(sys.argv) not in (3, 4) or sys.argv[2] not in ("true", "false"):
        fail("arguments")
    output_dir, dynamic = sys.argv[1], sys.argv[2] == "true"
    entries = set(os.listdir(output_dir))
    engine_dir = os.path.join(output_dir, ".youngflow")
    if ".youngflow" in entries:
        engine = os.lstat(engine_dir)
        if not stat.S_ISDIR(engine.st_mode) or stat.S_ISLNK(engine.st_mode):
            fail("engine output metadata")
        entries.remove(".youngflow")
    if entries != {"prepare-result.json"}:
        fail("output set")
    path = os.path.join(output_dir, "prepare-result.json")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        fail("file metadata")
    if stat.S_IMODE(info.st_mode) != 0o600 or not 0 < info.st_size <= MAX_BYTES:
        fail("file mode or size")
    value = load_unique(path)
    if not isinstance(value, dict) or set(value) != ALLOWED_KEYS:
        fail("fields")
    complete, sandbox, reason = value["project_complete"], value["sandbox_type"], value["reason"]
    if type(complete) is not bool or reason not in ALLOWED_REASONS:
        fail("types")
    if sandbox is not None and (not isinstance(sandbox, str) or not sandbox or len(sandbox) > 128):
        fail("sandbox_type")
    if not complete:
        valid = sandbox is None and reason == "partial_source"
    elif not dynamic:
        valid = sandbox is None and reason == "complete"
    elif sandbox is None:
        valid = reason == "no_compatible_sandbox"
    else:
        valid = reason == "complete" and sandbox in visible_profiles(sys.argv[3] if len(sys.argv) == 4 else None)
    if not valid:
        fail("combination")

if __name__ == "__main__":
    main()
