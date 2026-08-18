#!/usr/bin/env python3
"""Export VulnForge findings and risks to CSV.

Usage:
    python3 export-findings.py <output_dir> [options]

Examples:
    python3 export-findings.py .runs/ffmpeg-glm
    python3 export-findings.py .runs/wolfssl-glm --min-cvss 7.0 -o high-severity.csv
    python3 export-findings.py .runs/wolfssl-glm --ev-priority P0 --type finding
    python3 export-findings.py .runs/ffmpeg-glm --ev-priority P0,P1 --sort ev -o review.csv
"""
import argparse
import csv
import glob
import os
import sys
import yaml


COLUMNS = [
    "id",
    "type",
    "ev_priority",
    "ev_score",
    "ev_vector",
    "title",
    "severity",
    "cvss_score",
    "cvss_vector",
    "cwe",
    "vuln_type",
    "file_path",
    "line_number",
    "function",
    "source",
    "sink",
    "permission_requirement",
    "language",
    "ev_rationale",
    "description",
]


def _sanitize(v):
    """Clean string for CSV output."""
    if not isinstance(v, str):
        return v
    return v.replace("\n", " ").replace("\r", " ").replace('"', "'").strip()


def parse_finding(filepath, ftype):
    try:
        with open(filepath) as f:
            data = yaml.safe_load(f)
    except Exception:
        return None

    if not data:
        return None

    meta = data.get("metadata", data)
    desc = data.get("description", "")
    if isinstance(desc, dict):
        desc = desc.get("detailed_description", str(desc))
    if isinstance(desc, list):
        desc = " ".join(str(d) for d in desc)
    if isinstance(desc, str):
        desc = desc.replace("\n", " ").replace("\r", " ").replace('"', "'").strip()[:200]

    return {
        "id": meta.get("id", os.path.basename(filepath).replace(".yaml", "")),
        "type": ftype,
        "ev_priority": meta.get("ev_priority", ""),
        "ev_score": meta.get("ev_score", ""),
        "ev_vector": meta.get("ev_vector", ""),
        "title": _sanitize(meta.get("title", "")),
        "severity": meta.get("severity", ""),
        "cvss_score": meta.get("cvss_score", ""),
        "cvss_vector": meta.get("cvss_vector", ""),
        "cwe": meta.get("cwe", ""),
        "vuln_type": meta.get("vuln_type", ""),
        "file_path": meta.get("file_path", ""),
        "line_number": meta.get("line_number", ""),
        "function": _sanitize(meta.get("function", "")),
        "source": _sanitize(meta.get("source", "")),
        "sink": _sanitize(meta.get("sink", "")),
        "permission_requirement": _sanitize(meta.get("permission_requirement", "")),
        "language": meta.get("language", ""),
        "ev_rationale": _sanitize(meta.get("ev_rationale", "")),
        "description": desc,
    }


EV_PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "": 4}


def main():
    parser = argparse.ArgumentParser(description="Export VulnForge findings/risks to CSV")
    parser.add_argument("output_dir", help="Flow output directory (e.g. .runs/ffmpeg-glm)")
    parser.add_argument("--min-cvss", type=float, default=0, help="Minimum CVSS score filter (default: 0)")
    parser.add_argument("--min-ev", type=int, default=None, help="Minimum EV score filter")
    parser.add_argument("--ev-priority", default=None, help="EV priority filter, comma-separated (e.g. P0,P1)")
    parser.add_argument("--type", choices=["finding", "risk", "all"], default="all", help="Export type (default: all)")
    parser.add_argument("--sort", choices=["cvss", "ev"], default="ev", help="Sort by CVSS or EV score (default: ev)")
    parser.add_argument("-o", "--output", default=None, help="Output CSV path (default: stdout)")
    args = parser.parse_args()

    output_dir = args.output_dir.rstrip("/")
    if not os.path.isdir(output_dir):
        print(f"Error: {output_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    rows = []

    if args.type in ("finding", "all"):
        for f in sorted(glob.glob(f"{output_dir}/findings/*.yaml")):
            row = parse_finding(f, "finding")
            if row:
                rows.append(row)

    if args.type in ("risk", "all"):
        for f in sorted(glob.glob(f"{output_dir}/risks/*.yaml")):
            row = parse_finding(f, "risk")
            if row:
                rows.append(row)

    # Apply CVSS filter
    if args.min_cvss > 0:
        rows = [r for r in rows if _float(r.get("cvss_score")) >= args.min_cvss]

    # Apply EV score filter
    if args.min_ev is not None:
        rows = [r for r in rows if _float(r.get("ev_score")) >= args.min_ev]

    # Apply EV priority filter
    if args.ev_priority:
        allowed = set(p.strip() for p in args.ev_priority.split(","))
        rows = [r for r in rows if r.get("ev_priority") in allowed]

    # Sort
    if args.sort == "ev":
        rows.sort(key=lambda r: (EV_PRIORITY_ORDER.get(r.get("ev_priority", ""), 4), -_float(r.get("ev_score")), -_float(r.get("cvss_score"))))
    else:
        rows.sort(key=lambda r: -_float(r.get("cvss_score")))

    # Write CSV
    out = open(args.output, "w", newline="", encoding="utf-8") if args.output else sys.stdout
    writer = csv.DictWriter(out, fieldnames=COLUMNS, extrasaction="ignore", quoting=csv.QUOTE_ALL, escapechar="\\")
    writer.writeheader()
    writer.writerows(rows)

    if args.output:
        out.close()
        # Summary
        by_p = {}
        for r in rows:
            p = r.get("ev_priority", "?")
            by_p[p] = by_p.get(p, 0) + 1
        summary = " ".join(f"{p}:{c}" for p, c in sorted(by_p.items()))
        print(f"Exported {len(rows)} rows to {args.output} ({summary})", file=sys.stderr)
    else:
        print(f"\n# {len(rows)} rows exported", file=sys.stderr)


def _float(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


if __name__ == "__main__":
    main()
