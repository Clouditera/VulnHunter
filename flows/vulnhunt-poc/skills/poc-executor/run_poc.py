#!/usr/bin/env python3
"""
POC script executor — wraps poc.sh execution with real-time event streaming.
Captures stdout/stderr line by line, writes to run.log and *.service.jsonl.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def emit_event(events_file, event: dict) -> None:
    """Append a JSONL event to the events file."""
    with open(events_file, "a") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
        f.flush()


def main():
    parser = argparse.ArgumentParser(description="Execute POC script with event streaming")
    parser.add_argument("--bug-id", required=True, help="Bug ID (e.g. BUG-001)")
    parser.add_argument("--script", required=True, help="Path to poc.sh")
    parser.add_argument("--target-url", required=True, help="Target URL passed as $1 to script")
    parser.add_argument("--log", required=True, help="Output log file path")
    parser.add_argument("--events", required=True, help="Events JSONL file path")
    parser.add_argument("--timeout", type=int, default=300, help="Timeout in seconds")
    args = parser.parse_args()

    stage = f"generate-and-run-poc/{args.bug_id}"

    # Ensure directories exist
    os.makedirs(os.path.dirname(args.log) or ".", exist_ok=True)
    os.makedirs(os.path.dirname(args.events) or ".", exist_ok=True)

    # Make script executable
    os.chmod(args.script, 0o755)

    start_time = time.time()
    log_file = open(args.log, "w")

    emit_event(args.events, {
        "type": "poc_output",
        "ts": utc_now(),
        "stage": stage,
        "stream": "stdout",
        "message": f"[run_poc] Starting {args.bug_id}: {args.script} {args.target_url}",
    })

    try:
        proc = subprocess.Popen(
            ["bash", args.script, args.target_url],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=os.path.dirname(os.path.abspath(args.script)) or ".",
            env={**os.environ, "TARGET": args.target_url},
        )

        import selectors
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ)
        sel.register(proc.stderr, selectors.EVENT_READ)

        open_streams = 2
        while open_streams > 0:
            elapsed = time.time() - start_time
            if elapsed > args.timeout:
                proc.kill()
                emit_event(args.events, {
                    "type": "poc_output",
                    "ts": utc_now(),
                    "stage": stage,
                    "stream": "stderr",
                    "message": f"[run_poc] TIMEOUT after {args.timeout}s",
                })
                break

            remaining = args.timeout - elapsed
            events = sel.select(timeout=min(remaining, 1.0))

            for key, _ in events:
                line = key.fileobj.readline()
                if not line:
                    sel.unregister(key.fileobj)
                    open_streams -= 1
                    continue

                line = line.rstrip("\n")
                stream = "stdout" if key.fileobj == proc.stdout else "stderr"

                # Write to log file
                log_file.write(f"[{stream}] {line}\n")
                log_file.flush()

                # Emit event
                emit_event(args.events, {
                    "type": "poc_output",
                    "ts": utc_now(),
                    "stage": stage,
                    "stream": stream,
                    "message": line,
                })

        sel.close()
        proc.wait(timeout=10)
        exit_code = proc.returncode

    except Exception as e:
        exit_code = -1
        emit_event(args.events, {
            "type": "poc_output",
            "ts": utc_now(),
            "stage": stage,
            "stream": "stderr",
            "message": f"[run_poc] Error: {str(e)}",
        })

    duration_ms = int((time.time() - start_time) * 1000)
    log_file.close()

    # Emit exit event
    emit_event(args.events, {
        "type": "poc_exit",
        "ts": utc_now(),
        "stage": stage,
        "exit_code": exit_code,
        "duration_ms": duration_ms,
    })

    print(f"[run_poc] {args.bug_id} finished: exit_code={exit_code} duration={duration_ms}ms")
    sys.exit(0 if exit_code == 0 else 1)


if __name__ == "__main__":
    main()
