#!/usr/bin/env python3
"""Run one command under a trusted wall-clock deadline.

Exit 124 is reserved exclusively for a deadline reached by this supervisor.
Child exits (including 137/OOM) are preserved. External TERM/INT is forwarded
and reported as 128+signal, never as a deadline.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time


def event(name: str, **fields: object) -> None:
    print(json.dumps({"event": name, **fields}, separators=(",", ":")), file=sys.stderr, flush=True)


def child_code(code: int) -> int:
    return 128 + (-code) if code < 0 else code


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--timeout", type=float, required=True)
    parser.add_argument("--grace", type=float, default=30.0)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not (args.timeout > 0) or not (0 <= args.grace <= 300):
        parser.error("positive --timeout, bounded --grace, and command are required")

    external_signal: int | None = None

    def remember(signum: int, _frame: object) -> None:
        nonlocal external_signal
        if external_signal is None:
            external_signal = signum

    old_handlers = {sig: signal.signal(sig, remember) for sig in (signal.SIGTERM, signal.SIGINT)}
    child: subprocess.Popen[bytes] | None = None
    try:
        child = subprocess.Popen(command, start_new_session=True)
        started = time.monotonic()
        deadline = started + args.timeout
        while True:
            code = child.poll()
            if code is not None:
                natural = child_code(code)
                if natural == 124:
                    event("child_reserved_exit", child_exit=124, mapped_exit=125)
                    return 125
                return natural
            if external_signal is not None:
                event("external_signal", signal=external_signal)
                return terminate_group(child, external_signal, args.grace, 128 + external_signal)
            if time.monotonic() >= deadline:
                event("deadline_reached", timeout_seconds=args.timeout)
                terminate_group(child, signal.SIGTERM, args.grace, 124)
                return 124
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    except BaseException as exc:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
            except BaseException:
                pass
        event("supervisor_error", error=type(exc).__name__)
        return 125
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)


def terminate_group(child: subprocess.Popen[bytes], first_signal: int, grace: float, result: int) -> int:
    try:
        os.killpg(child.pid, first_signal)
    except ProcessLookupError:
        child.wait()
        return result
    end = time.monotonic() + grace
    while child.poll() is None and time.monotonic() < end:
        time.sleep(0.05)
    if child.poll() is None:
        event("kill_grace_exhausted", grace_seconds=grace)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=max(1.0, grace))
    except subprocess.TimeoutExpired:
        return 125
    return result


if __name__ == "__main__":
    raise SystemExit(main())
