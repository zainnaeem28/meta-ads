"""Shared report helpers for the CI wrappers and the quality gate (standard library only).

Every wrapper writes its report under reports/ and then a sidecar meta file under reports/meta/<id>.json
that names the commit, the tool, its exit code and the hash of the report. The gate trusts nothing it
cannot read back from disk: a missing, empty, stale or wrong-commit report fails.
"""

import datetime
import hashlib
import json
import os
import subprocess
import sys

META_DIR = "meta"
STATUSES = ("pass", "fail", "not_applicable", "stub")


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_sha(repo_root):
    """The commit under test: CI_SOURCE_SHA, then GITHUB_SHA, then the checked-out HEAD."""
    for name in ("CI_SOURCE_SHA", "GITHUB_SHA"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    out = subprocess.run(
        ["git", "-C", repo_root, "rev-parse", "HEAD"], capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise RuntimeError("cannot determine the source commit: " + out.stderr.strip())
    return out.stdout.strip()


def commit_time(repo_root, sha):
    """Committer time (epoch seconds) of sha, or None when git cannot tell."""
    out = subprocess.run(
        ["git", "-C", repo_root, "show", "-s", "--format=%ct", sha],
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        return None
    try:
        return int(out.stdout.strip())
    except ValueError:
        return None


def meta_path(reports_dir, report_id):
    return os.path.join(reports_dir, META_DIR, report_id + ".json")


def write_meta(
    reports_dir,
    report_id,
    kind,
    status,
    sha,
    tool="",
    exit_code=0,
    report=None,
    reason="",
    started_at=None,
):
    """Write the sidecar for one report. `report` is a path relative to reports_dir."""
    if status not in STATUSES:
        raise ValueError("unknown status " + status)
    meta = {
        "id": report_id,
        "kind": kind,
        "status": status,
        "sourceSha": sha,
        "tool": tool,
        "exitCode": int(exit_code),
        "report": report,
        "reportSha256": None,
        "reason": reason,
        "startedAt": started_at or now_iso(),
        "finishedAt": now_iso(),
    }
    if report:
        full = os.path.join(reports_dir, report)
        if os.path.isfile(full):
            meta["reportSha256"] = sha256_file(full)
    target = meta_path(reports_dir, report_id)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)
        handle.write("\n")
    return meta


def read_meta(reports_dir, report_id):
    """Return (meta, problem). Exactly one of the two is None."""
    path = meta_path(reports_dir, report_id)
    if not os.path.isfile(path):
        return None, "no meta file for report '%s' (the wrapper did not run or crashed)" % report_id
    try:
        with open(path, encoding="utf-8") as handle:
            meta = json.load(handle)
    except (OSError, ValueError) as err:
        return None, "meta file for '%s' is unreadable: %s" % (report_id, err)
    if not isinstance(meta, dict) or meta.get("status") not in STATUSES:
        return None, "meta file for '%s' is malformed" % report_id
    return meta, None


def _cli(argv):
    """report_meta CLI used by lib.sh: write <reports> <id> <kind> <status> <sha> <tool> <exit> [report] [reason]."""
    if len(argv) < 8 or argv[0] != "write":
        sys.stderr.write("usage: ci_reports.py write REPORTS ID KIND STATUS SHA TOOL EXIT [REPORT] [REASON]\n")
        return 2
    _, reports_dir, report_id, kind, status, sha, tool, exit_code = argv[:8]
    report = argv[8] if len(argv) > 8 and argv[8] else None
    reason = argv[9] if len(argv) > 9 else ""
    write_meta(reports_dir, report_id, kind, status, sha, tool, exit_code, report, reason)
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
