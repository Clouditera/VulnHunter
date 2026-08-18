#!/usr/bin/env python3
"""CVSS v3.1 Base Score Calculator and Exploit Value (EV) Calculator.

Usage:
    python3 cvss-calc.py "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
    python3 cvss-calc.py ev "EV:1.0/R:N/E:D/C:D/I:X"
    python3 cvss-calc.py AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H

Output:
    9.8 critical
    10 P0

Can also be used to batch-fix YAML files:
    python3 cvss-calc.py --fix path/to/findings/
"""
import math
import sys
import os
import glob

# ============================================================================
# CVSS v3.1
# ============================================================================

AV = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.20}
AC = {"L": 0.77, "H": 0.44}
PR_U = {"N": 0.85, "L": 0.62, "H": 0.27}
PR_C = {"N": 0.85, "L": 0.68, "H": 0.50}
UI = {"N": 0.85, "R": 0.62}
CIA = {"H": 0.56, "L": 0.22, "N": 0.0}

SEVERITY = {
    (0.0, 0.0): "none",
    (0.1, 3.9): "low",
    (4.0, 6.9): "medium",
    (7.0, 8.9): "high",
    (9.0, 10.0): "critical",
}


def roundup(x: float) -> float:
    """CVSS spec roundup: smallest 0.1 >= x."""
    return math.ceil(x * 10) / 10


def severity(score: float) -> str:
    for (lo, hi), label in SEVERITY.items():
        if lo <= score <= hi:
            return label
    return "unknown"


def cvss31(vector: str) -> tuple[float, str]:
    """Calculate CVSS 3.1 base score from vector string. Returns (score, severity)."""
    clean = vector.replace("CVSS:3.1/", "")
    metrics = {}
    for part in clean.split("/"):
        if ":" in part:
            k, v = part.split(":", 1)
            metrics[k] = v

    required = {"AV", "AC", "PR", "UI", "S", "C", "I", "A"}
    missing = required - set(metrics.keys())
    if missing:
        raise ValueError(f"Missing metrics: {missing}")

    sc = metrics["S"] == "C"
    pr_map = PR_C if sc else PR_U

    iss = 1 - (1 - CIA[metrics["C"]]) * (1 - CIA[metrics["I"]]) * (1 - CIA[metrics["A"]])

    if iss <= 0:
        return 0.0, "none"

    if sc:
        impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    else:
        impact = 6.42 * iss

    if impact <= 0:
        return 0.0, "none"

    exploitability = 8.22 * AV[metrics["AV"]] * AC[metrics["AC"]] * pr_map[metrics["PR"]] * UI[metrics["UI"]]

    if sc:
        base = roundup(min(1.08 * (impact + exploitability), 10.0))
    else:
        base = roundup(min(impact + exploitability, 10.0))

    return base, severity(base)


# ============================================================================
# Exploit Value (EV)
# ============================================================================

EV_R = {"N": 3, "M": 2, "L": 1, "P": 0}   # Reachability
EV_E = {"D": 3, "C": 2, "R": 1, "P": 0}   # Exposure
EV_C = {"D": 2, "F": 1, "T": 0}            # Certainty
EV_I = {"X": 2, "S": 1, "D": 0}            # Impact

EV_PRIORITY = {
    (8, 10): "P0",
    (6, 7): "P1",
    (4, 5): "P2",
    (0, 3): "P3",
}


def ev_priority(score: int) -> str:
    for (lo, hi), label in EV_PRIORITY.items():
        if lo <= score <= hi:
            return label
    return "P3"


def ev_calc(vector: str) -> tuple[int, str]:
    """Calculate EV score from vector string. Returns (score, priority)."""
    clean = vector.replace("EV:1.0/", "")
    metrics = {}
    for part in clean.split("/"):
        if ":" in part:
            k, v = part.split(":", 1)
            metrics[k] = v

    required = {"R", "E", "C", "I"}
    missing = required - set(metrics.keys())
    if missing:
        raise ValueError(f"Missing EV metrics: {missing}")

    score = EV_R[metrics["R"]] + EV_E[metrics["E"]] + EV_C[metrics["C"]] + EV_I[metrics["I"]]
    return score, ev_priority(score)


def fix_yaml_files(dirs: list[str]) -> int:
    """Batch-fix cvss_score and severity in YAML files. Returns count of fixed files."""
    fixed = 0
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, "*.yaml"))):
            try:
                with open(f) as fh:
                    content = fh.read()
            except Exception:
                continue

            # Find cvss_vector line
            vector = None
            for line in content.splitlines():
                stripped = line.strip()
                if stripped.startswith("cvss_vector:"):
                    vector = stripped.split(":", 1)[1].strip().strip('"').strip("'")
                    break

            if not vector or "AV:" not in vector:
                continue

            try:
                score, sev = cvss31(vector)
            except (ValueError, KeyError):
                continue

            # Read current score
            new_content = content
            changed = False

            for line in content.splitlines():
                stripped = line.strip()
                if stripped.startswith("cvss_score:"):
                    old_val = stripped.split(":", 1)[1].strip()
                    try:
                        old_score = float(old_val)
                    except ValueError:
                        old_score = None
                    if old_score != score:
                        new_content = new_content.replace(line, line.split("cvss_score:")[0] + f"cvss_score: {score}")
                        changed = True
                elif stripped.startswith("severity:"):
                    old_sev = stripped.split(":", 1)[1].strip().strip('"').strip("'")
                    if old_sev != sev:
                        new_content = new_content.replace(line, line.split("severity:")[0] + f"severity: {sev}")
                        changed = True

            if changed:
                with open(f, "w") as fh:
                    fh.write(new_content)
                fixed += 1
                print(f"  fixed {os.path.basename(f)}: {score} {sev}")

    return fixed


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: cvss-calc.py <vector> | cvss-calc.py ev <vector> | cvss-calc.py --fix <dir> [dir...]", file=sys.stderr)
        sys.exit(1)

    if sys.argv[1] == "--fix":
        dirs = sys.argv[2:]
        if not dirs:
            print("Usage: cvss-calc.py --fix <dir> [dir...]", file=sys.stderr)
            sys.exit(1)
        n = fix_yaml_files(dirs)
        print(f"\nFixed {n} file(s)")
    elif sys.argv[1] == "ev":
        if len(sys.argv) < 3:
            print("Usage: cvss-calc.py ev <EV vector>", file=sys.stderr)
            sys.exit(1)
        try:
            score, priority = ev_calc(sys.argv[2])
            print(f"{score} {priority}")
        except (ValueError, KeyError) as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        vector = sys.argv[1]
        try:
            score, sev = cvss31(vector)
            print(f"{score} {sev}")
        except (ValueError, KeyError) as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
