"""Build a reports directory from the gate fixtures, the same way the wrappers do (probe helper).

  assemble.py DEST SHA [--set ID=FIXTURE] [--status ID=STATUS] [--wrong-sha ID] [--drop-meta ID]
              [--delete-report ID] [--stale ID] [--tamper ID]

Starts from an all-green set for the 'ticket' profile, then applies each requested damage.
"""

import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import ci_reports  # noqa: E402

GATE = os.path.join(HERE, "gate")
SUMMARY = ["lint", "types", "layers", "contract"]
DEFAULT = {
    "unit-ci": ("junit", "ci/junit.xml", "junit-pass.xml"),
    "sast": ("findings", "sast.sarif", "sarif-clean.sarif"),
    "deps": ("findings", "deps.sarif", "sarif-clean.sarif"),
    "deps-audit": ("findings", "audit.json", "audit-clean.json"),
    "secrets": ("secrets", "secrets.sarif", "sarif-clean.sarif"),
}


def report_path(rid):
    return os.path.join("ci", "junit.xml") if rid == "unit-ci" else (DEFAULT[rid][1] if rid in DEFAULT else "%s/summary.json" % rid)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dest")
    parser.add_argument("sha")
    parser.add_argument("--set", action="append", default=[])
    parser.add_argument("--status", action="append", default=[])
    parser.add_argument("--wrong-sha", action="append", default=[])
    parser.add_argument("--drop-meta", action="append", default=[])
    parser.add_argument("--delete-report", action="append", default=[])
    parser.add_argument("--stale", action="append", default=[])
    parser.add_argument("--tamper", action="append", default=[])
    parser.add_argument("--lcov", default="lcov-good.info")
    args = parser.parse_args()
    shutil.rmtree(args.dest, ignore_errors=True)
    os.makedirs(args.dest)
    overrides = dict(item.split("=", 1) for item in args.set)
    statuses = dict(item.split("=", 1) for item in args.status)
    for rid in SUMMARY:
        os.makedirs(os.path.join(args.dest, rid))
        with open(os.path.join(args.dest, rid, "summary.json"), "w", encoding="utf-8") as handle:
            handle.write('{"id": "%s", "exitCode": 0, "sourceSha": "%s"}\n' % (rid, args.sha))
        status = "stub" if rid == "contract" else "pass"
        ci_reports.write_meta(args.dest, rid, "summary", statuses.get(rid, status), args.sha, "probe", 0,
                              "%s/summary.json" % rid)
    for rid, (kind, rel, fixture) in DEFAULT.items():
        target = os.path.join(args.dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy(os.path.join(GATE, overrides.get(rid, fixture)), target)
        if rid == "unit-ci":
            shutil.copy(os.path.join(GATE, args.lcov), os.path.join(args.dest, "ci", "lcov.info"))
        status = statuses.get(rid, "pass")
        code = 0 if status == "pass" else 2
        ci_reports.write_meta(args.dest, rid, kind, status, args.sha, "probe", code, rel)
    for rid in args.tamper:
        rel = report_path(rid)
        with open(os.path.join(args.dest, rel), "a", encoding="utf-8") as handle:
            handle.write("\n")
    for rid in args.wrong_sha:
        meta, _ = ci_reports.read_meta(args.dest, rid)
        ci_reports.write_meta(args.dest, rid, meta["kind"], meta["status"], "0" * 40, "probe", 0, meta["report"])
    for rid in args.delete_report:
        os.remove(os.path.join(args.dest, report_path(rid)))
    for rid in args.stale:
        os.utime(os.path.join(args.dest, report_path(rid)), (1_000_000_000, 1_000_000_000))
    for rid in args.drop_meta:
        os.remove(ci_reports.meta_path(args.dest, rid))


if __name__ == "__main__":
    main()
