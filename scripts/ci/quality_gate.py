"""Quality gate: reads every report from disk and decides (standard library only).

  quality_gate.py --reports reports --profile ticket|release [--policy P] [--dispositions D] [--sha SHA]
                  [--repo ROOT] [--workflow FILE] [--out FILE]

The gate trusts no exit code. For every report in the policy inventory for the profile it reads the sidecar
meta file and the report itself and fails on: a missing, empty, malformed, stale or wrong-commit report, a
failed or crashed tool, a suite that ran zero tests, coverage under the minimum, a blocking finding or any
secret. It also checks that the CI workflow still holds every required job and is pinned. It writes the
quality manifest (quality.json) and exits 0 on PASS, 1 on FAIL, 2 on a usage error.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ci_reports  # noqa: E402
import evaluate_findings  # noqa: E402

DEFAULT_REPO = os.path.abspath(os.path.join(HERE, "..", ".."))


class Result:
    def __init__(self):
        self.checks = []

    def add(self, check_id, ok, detail):
        self.checks.append({"id": check_id, "result": "PASS" if ok else "FAIL", "detail": detail})

    @property
    def ok(self):
        return all(c["result"] == "PASS" for c in self.checks)


def parse_junit(path):
    """Return (executed, skipped, failed) test counts. Raises ValueError on malformed XML."""
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as err:
        raise ValueError("JUnit report is malformed: %s" % err)
    cases = list(root.iter("testcase"))
    if not cases:
        return 0, 0, 0
    skipped = sum(1 for c in cases if c.find("skipped") is not None)
    failed = sum(1 for c in cases if c.find("failure") is not None or c.find("error") is not None)
    return len(cases) - skipped, skipped, failed


def parse_lcov(path):
    """Return {'lines': pct or None, 'branches': pct or None}."""
    totals = {"LF": 0, "LH": 0, "BRF": 0, "BRH": 0}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            key, _, value = raw.strip().partition(":")
            if key in totals:
                try:
                    totals[key] += int(value)
                except ValueError:
                    raise ValueError("lcov has a non-numeric %s record" % key)
    lines = 100.0 * totals["LH"] / totals["LF"] if totals["LF"] else None
    branches = 100.0 * totals["BRH"] / totals["BRF"] if totals["BRF"] else None
    return {"lines": lines, "branches": branches}


def check_report_file(meta, entry, reports_dir, repo, sha):
    """Existence, content hash and freshness of the primary report. Returns a problem string or None."""
    rel = meta.get("report") or entry["report"]
    if rel != entry["report"]:
        return "meta names report '%s' but the policy expects '%s'" % (rel, entry["report"])
    full = os.path.join(reports_dir, rel)
    if not os.path.isfile(full):
        return "report file '%s' is missing" % rel
    if os.path.getsize(full) == 0:
        return "report file '%s' is empty" % rel
    if meta.get("reportSha256") != ci_reports.sha256_file(full):
        return "report file '%s' does not match the hash its wrapper recorded" % rel
    committed = ci_reports.commit_time(repo, sha)
    if committed is not None and int(os.path.getmtime(full)) < committed:
        return "report file '%s' is older than commit %s (stale)" % (rel, sha[:12])
    return None


def check_entry(entry, reports_dir, repo, sha, policy, dispositions, out_dir):
    """Return (ok, detail) for one inventory entry."""
    meta, problem = ci_reports.read_meta(reports_dir, entry["id"])
    if problem:
        return False, problem
    if meta.get("sourceSha") != sha:
        return False, "report is for commit %s, expected %s (wrong commit)" % (
            str(meta.get("sourceSha"))[:12], sha[:12])
    status = meta["status"]
    if status == "fail":
        return False, "wrapper recorded a failure (exit %s): %s" % (meta.get("exitCode"), meta.get("reason") or "-")
    if status == "not_applicable":
        absent = entry.get("notApplicableWhenAbsent")
        if not absent:
            return False, "not_applicable is not allowed for this report"
        present = [p for p in absent if os.path.exists(os.path.join(repo, p))]
        if present:
            return False, "marked not applicable but %s exists" % ", ".join(present)
        return True, "not applicable (%s)" % (meta.get("reason") or "nothing to scan")
    if status == "stub":
        if not entry.get("stubAllowed"):
            return False, "a stub run is not allowed for this report"
        return True, "stub accepted until %s" % entry["stubAllowed"]
    if meta.get("exitCode") not in (0, "0"):
        return False, "status pass but the tool exit code is %s" % meta.get("exitCode")
    if entry["kind"] == "summary":
        return True, "tool %s passed" % (meta.get("tool") or "-")
    problem = check_report_file(meta, entry, reports_dir, repo, sha)
    if problem:
        return False, problem
    full = os.path.join(reports_dir, entry["report"])
    kind = entry["kind"]
    if kind == "junit":
        try:
            executed, skipped, failed = parse_junit(full)
        except ValueError as err:
            return False, str(err)
        if failed:
            return False, "%d test(s) failed" % failed
        if executed < entry.get("minTests", 1):
            return False, "only %d test(s) ran (%d skipped); at least %d required" % (
                executed, skipped, entry.get("minTests", 1))
        detail = "%d tests ran, %d skipped" % (executed, skipped)
        if entry.get("coverage"):
            ok, cov = check_coverage(entry, reports_dir, policy)
            if not ok:
                return False, cov
            detail += "; " + cov
        return True, detail
    result = evaluate_findings.evaluate(full, policy, dispositions, secrets=(kind == "secrets"))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, entry["id"] + ".json"), "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)
            handle.write("\n")
    if not result["ok"]:
        return False, "; ".join(evaluate_findings.summarize(result).splitlines()[:-1][:5]) or "findings failed"
    return True, "%d recorded, %d dismissed" % (len(result["nonBlocking"]), len(result["dismissed"]))


def check_coverage(entry, reports_dir, policy):
    cov_path = os.path.join(reports_dir, entry["coverage"])
    if not os.path.isfile(cov_path) or os.path.getsize(cov_path) == 0:
        return False, "coverage report '%s' is missing or empty" % entry["coverage"]
    minimums = policy["coverage"]["classes"][entry["coverageClass"]]
    try:
        measured = parse_lcov(cov_path)
    except ValueError as err:
        return False, str(err)
    parts = []
    for metric in ("lines", "branches"):
        if measured[metric] is None:
            if minimums[metric]:
                return False, "coverage report does not measure %s" % metric
            continue
        if measured[metric] < minimums[metric]:
            return False, "%s coverage %.1f%% is under the %s minimum of %s%%" % (
                metric, measured[metric], entry["coverageClass"], minimums[metric])
        parts.append("%s %.1f%%" % (metric, measured[metric]))
    return True, "coverage " + ", ".join(parts)


# ----- workflow inventory -----------------------------------------------------------------------


def workflow_jobs(text):
    jobs, in_jobs = [], False
    for line in text.splitlines():
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
            continue
        if in_jobs:
            if re.match(r"^\S", line) and not line.startswith("#"):
                break
            match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
            if match:
                jobs.append(match.group(1))
    return jobs


def check_workflow(policy, repo, profile, workflow_file=None):
    wf = policy["workflow"]
    path = workflow_file or os.path.join(repo, wf["file"])
    if not os.path.isfile(path):
        if profile == "release":
            return False, "workflow '%s' does not exist" % wf["file"]
        return True, "no workflow yet (checked in the release profile)"
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    problems = []
    jobs = workflow_jobs(text)
    missing = [j for j in wf["requiredJobs"] if j not in jobs]
    if missing:
        problems.append("required job(s) missing: " + ", ".join(missing))
    for line in text.splitlines():
        uses = re.match(r"^\s*-?\s*uses:\s*([^\s#]+)", line)
        if uses and not uses.group(1).startswith("./") and not re.search(r"@[0-9a-f]{40}$", uses.group(1)):
            problems.append("unpinned action %s" % uses.group(1))
        for trigger in wf["forbiddenTriggers"]:
            if re.match(r"^\s*%s\s*:" % re.escape(trigger), line):
                problems.append("forbidden trigger %s" % trigger)
        if re.match(r"^\s*continue-on-error:\s*true", line):
            problems.append("continue-on-error is not allowed")
        perm = re.match(r"^\s*permissions:\s*(read-all|write-all)\s*$", line)
        if perm:
            problems.append("permissions %s is wider than the allow-list" % perm.group(1))
    in_permissions = False
    for line in text.splitlines():
        if re.match(r"^\s*permissions:\s*$", line):
            in_permissions = True
            continue
        if in_permissions:
            item = re.match(r"^\s+([a-z-]+):\s*(\S+)", line)
            if not item:
                in_permissions = False
                continue
            pair = "%s: %s" % (item.group(1), item.group(2))
            if pair not in wf["allowedPermissions"] and item.group(2) != "none" and not pair.endswith(": read"):
                problems.append("permission %s is outside the allow-list" % pair)
    if problems:
        return False, "; ".join(sorted(set(problems)))
    return True, "%d jobs, all %d required present, actions pinned" % (len(jobs), len(wf["requiredJobs"]))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reports", required=True)
    parser.add_argument("--profile", default="ticket")
    parser.add_argument("--policy", default=os.path.join(DEFAULT_REPO, "config", "quality-policy.json"))
    parser.add_argument("--dispositions", default=os.path.join(DEFAULT_REPO, "config", "dispositions.json"))
    parser.add_argument("--sha", default=None)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--workflow", default=None)
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)
    try:
        policy = evaluate_findings.load_policy(args.policy)
        sha = args.sha or ci_reports.source_sha(args.repo)
    except (evaluate_findings.ToolFailure, RuntimeError) as err:
        sys.stderr.write("quality_gate: %s\n" % err)
        return 2
    if args.profile not in policy["profiles"]:
        sys.stderr.write("quality_gate: unknown profile %s\n" % args.profile)
        return 2
    with open(args.policy, "rb") as handle:
        policy_revision = hashlib.sha256(handle.read()).hexdigest()
    result = Result()
    findings_dir = os.path.join(args.reports, "findings")
    for entry in policy["reports"]:
        if args.profile not in entry["profiles"]:
            continue
        try:
            ok, detail = check_entry(entry, args.reports, args.repo, sha, policy, args.dispositions, findings_dir)
        except Exception as err:  # a crash of the gate itself is a failure, never a pass
            ok, detail = False, "gate error: %s" % err
        result.add(entry["id"], ok, detail)
    ok, detail = check_workflow(policy, args.repo, args.profile, args.workflow)
    result.add("workflow", ok, detail)
    manifest = {
        "sourceSha": sha,
        "policyRevision": policy_revision,
        "profile": args.profile,
        "result": "PASS" if result.ok else "FAIL",
        "checks": result.checks,
        "generatedAt": ci_reports.now_iso(),
    }
    out = args.out or os.path.join(args.reports, "quality.json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    for check in result.checks:
        print("%-4s %-12s %s" % (check["result"], check["id"], check["detail"]))
    print("QUALITY GATE %s (profile %s, commit %s)" % (manifest["result"], args.profile, sha[:12]))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
