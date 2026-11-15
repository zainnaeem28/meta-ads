import json
import os
import shutil
import subprocess
import time

import pytest
from conftest import GATE, ROOT

import ci_reports
import quality_gate as qg

SHA = "a" * 40


@pytest.fixture
def repo(tmp_path):
    """A throwaway git repository so commit-time checks run against a real commit."""
    repo = tmp_path / "repo"
    repo.mkdir()
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}
    for args in (["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "c"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)
    sha = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    return str(repo), sha


def build(tmp_path, sha, junit="junit-pass.xml", lcov="lcov-good.info", sast="sarif-clean.sarif"):
    reports = tmp_path / "reports"
    shutil.rmtree(reports, ignore_errors=True)
    for rid in ("lint", "types", "layers", "contract"):
        (reports / rid).mkdir(parents=True)
        (reports / rid / "summary.json").write_text(json.dumps({"id": rid, "exitCode": 0, "sourceSha": sha}))
        ci_reports.write_meta(str(reports), rid, "summary", "stub" if rid == "contract" else "pass", sha, "t", 0,
                              rid + "/summary.json")
    files = {"unit-ci": ("junit", "ci/junit.xml", junit), "sast": ("findings", "sast.sarif", sast),
             "deps": ("findings", "deps.sarif", "sarif-clean.sarif"),
             "deps-audit": ("findings", "audit.json", "audit-clean.json"),
             "secrets": ("secrets", "secrets.sarif", "sarif-clean.sarif")}
    for rid, (kind, rel, src) in files.items():
        (reports / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(os.path.join(GATE, src), reports / rel)
        ci_reports.write_meta(str(reports), rid, kind, "pass", sha, "t", 0, rel)
    shutil.copy(os.path.join(GATE, lcov), reports / "ci" / "lcov.info")
    return str(reports)


def gate(reports, repo, sha, profile="ticket", workflow=None, extra=()):
    argv = ["--reports", reports, "--repo", repo, "--sha", sha, "--profile", profile,
            "--dispositions", os.path.join(ROOT, "config", "dispositions.json"),
            "--policy", os.path.join(ROOT, "config", "quality-policy.json")]
    if workflow:
        argv += ["--workflow", workflow]
    return qg.main(argv + list(extra))


def test_green_reports_pass_and_write_the_manifest(tmp_path, repo, capsys):
    root, sha = repo
    reports = build(tmp_path, sha)
    assert gate(reports, root, sha) == 0
    manifest = json.load(open(os.path.join(reports, "quality.json")))
    assert manifest["result"] == "PASS" and manifest["sourceSha"] == sha
    assert len(manifest["policyRevision"]) == 64
    assert "QUALITY GATE PASS" in capsys.readouterr().out


def test_failing_and_missing_inputs_fail(tmp_path, repo):
    root, sha = repo
    assert gate(build(tmp_path, sha, junit="junit-fail.xml"), root, sha) == 1
    assert gate(build(tmp_path, sha, sast="sarif-critical.sarif"), root, sha) == 1
    assert gate(build(tmp_path, sha), root, "b" * 40) == 1  # every report is for another commit
    reports = build(tmp_path, sha)
    os.remove(os.path.join(reports, "ci", "lcov.info"))
    assert gate(reports, root, sha) == 1


def test_coverage_edge_cases(tmp_path, repo):
    root, sha = repo
    assert gate(build(tmp_path, sha, lcov="lcov-low.info"), root, sha) == 1
    reports = build(tmp_path, sha)
    open(os.path.join(reports, "ci", "lcov.info"), "w").write("SF:a\nLF:2\nLH:2\nend_of_record\n")  # no branches
    assert gate(reports, root, sha) == 1
    open(os.path.join(reports, "ci", "lcov.info"), "w").write("SF:a\nLF:x\nend_of_record\n")
    assert gate(reports, root, sha) == 1
    with pytest.raises(ValueError):
        qg.parse_lcov(os.path.join(reports, "ci", "lcov.info"))
    assert qg.parse_lcov(os.path.join(GATE, "lcov-good.info")) == {"lines": 100.0, "branches": 100.0}


def test_junit_parsing(tmp_path):
    assert qg.parse_junit(os.path.join(GATE, "junit-pass.xml")) == (3, 0, 0)
    assert qg.parse_junit(os.path.join(GATE, "junit-skipped.xml")) == (0, 2, 0)
    assert qg.parse_junit(os.path.join(GATE, "junit-zero.xml")) == (0, 0, 0)
    bad = tmp_path / "bad.xml"
    bad.write_text("<testsuites>")
    with pytest.raises(ValueError):
        qg.parse_junit(str(bad))


def test_report_file_problems(tmp_path, repo):
    root, sha = repo
    reports = build(tmp_path, sha)
    open(os.path.join(reports, "sast.sarif"), "w").close()
    assert gate(reports, root, sha) == 1  # empty
    reports = build(tmp_path, sha)
    os.utime(os.path.join(reports, "sast.sarif"), (1_000_000_000, 1_000_000_000))
    assert gate(reports, root, sha) == 1  # stale
    reports = build(tmp_path, sha)
    ci_reports.write_meta(reports, "sast", "findings", "pass", sha, "t", 0, "other.sarif")
    assert gate(reports, root, sha) == 1  # meta names another report
    reports = build(tmp_path, sha)
    ci_reports.write_meta(reports, "sast", "findings", "pass", sha, "t", 3, "sast.sarif")
    assert gate(reports, root, sha) == 1  # pass with a non-zero exit code
    reports = build(tmp_path, sha)
    ci_reports.write_meta(reports, "sast", "findings", "fail", sha, "t", 1, "sast.sarif")
    assert gate(reports, root, sha) == 1


def test_not_applicable_and_stub_rules(tmp_path, repo):
    root, sha = repo
    reports = build(tmp_path, sha)
    ci_reports.write_meta(reports, "sast", "findings", "not_applicable", sha, "t", 0)
    assert gate(reports, root, sha) == 1  # sast may never be not applicable
    reports = build(tmp_path, sha)
    ci_reports.write_meta(reports, "lint", "summary", "stub", sha, "t", 0)
    assert gate(reports, root, sha) == 1  # lint may never be a stub
    reports = build(tmp_path, sha)
    ci_reports.write_meta(reports, "e2e", "junit", "not_applicable", sha, "t", 0)
    assert gate(reports, root, sha, profile="release") == 1  # release also lacks other reports
    entry = {"id": "e2e", "kind": "junit", "report": "e2e/junit.xml", "notApplicableWhenAbsent": ["Nothing.here", "also.no"]}
    policy = json.load(open(os.path.join(ROOT, "config", "quality-policy.json")))
    ok, detail = qg.check_entry(entry, reports, root, sha, policy, None, None)
    assert ok and "not applicable" in detail
    open(os.path.join(root, "Nothing.here"), "w").close()
    ok, detail = qg.check_entry(entry, reports, root, sha, policy, None, None)
    assert not ok and "exists" in detail


def test_gate_errors_become_failures(tmp_path, repo, monkeypatch):
    root, sha = repo
    reports = build(tmp_path, sha)

    def boom(*args, **kwargs):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(qg, "check_entry", boom)
    assert gate(reports, root, sha) == 1


WORKFLOW = """name: ci
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
%s
"""


def workflow_text(jobs, uses="actions/checkout@" + "1" * 40, extra=""):
    body = "".join("  %s:\n    runs-on: x\n    steps:\n      - uses: %s\n%s" % (j, uses, extra) for j in jobs)
    return WORKFLOW % body


def test_workflow_checks(tmp_path):
    policy = json.load(open(os.path.join(ROOT, "config", "quality-policy.json")))
    jobs = policy["workflow"]["requiredJobs"]

    def check(text, profile="release"):
        path = tmp_path / "ci.yml"
        path.write_text(text)
        return qg.check_workflow(policy, str(tmp_path), profile, str(path))

    assert check(workflow_text(jobs))[0]
    assert not check(workflow_text(jobs[:-1]))[0]
    assert "unpinned" in check(workflow_text(jobs, uses="actions/checkout@v4"))[1]
    assert check(workflow_text(jobs, uses="./.github/actions/x"))[0]
    assert "forbidden trigger" in check(workflow_text(jobs).replace("on:\n", "on:\n  schedule:\n"))[1]
    assert "continue-on-error" in check(workflow_text(jobs, extra="        continue-on-error: true\n"))[1]
    assert "write-all" in check(workflow_text(jobs).replace("contents: read", "write-all").replace(
        "permissions:\n  write-all", "permissions: write-all"))[1]
    wide = workflow_text(jobs).replace("contents: read", "contents: write")
    assert "outside the allow-list" in check(wide)[1]
    assert check(workflow_text(jobs).replace("contents: read", "issues: none"))[0]


def test_missing_workflow_depends_on_profile(tmp_path):
    policy = json.load(open(os.path.join(ROOT, "config", "quality-policy.json")))
    assert qg.check_workflow(policy, str(tmp_path), "ticket")[0]
    assert not qg.check_workflow(policy, str(tmp_path), "release")[0]


def test_usage_errors(tmp_path, repo, capsys):
    root, sha = repo
    assert qg.main(["--reports", str(tmp_path), "--repo", root, "--sha", sha, "--policy", str(tmp_path / "x")]) == 2
    assert qg.main(["--reports", str(tmp_path), "--repo", root, "--sha", sha, "--profile", "nope"]) == 2
    assert qg.main(["--reports", str(tmp_path), "--repo", str(tmp_path), "--profile", "ticket"]) == 2
    assert "quality_gate:" in capsys.readouterr().err


def test_summary_reports_are_read_from_disk(tmp_path, repo):
    root, sha = repo
    for damage in ("missing", "empty", "exit", "sha", "malformed", "stale"):
        reports = build(tmp_path, sha)
        target = os.path.join(reports, "lint", "summary.json")
        if damage == "missing":
            os.remove(target)
        elif damage == "empty":
            open(target, "w").close()
        elif damage == "exit":
            json.dump({"exitCode": 9, "sourceSha": sha}, open(target, "w"))
            ci_reports.write_meta(reports, "lint", "summary", "pass", sha, "t", 0, "lint/summary.json")
        elif damage == "sha":
            json.dump({"exitCode": 0, "sourceSha": "0" * 40}, open(target, "w"))
            ci_reports.write_meta(reports, "lint", "summary", "pass", sha, "t", 0, "lint/summary.json")
        elif damage == "malformed":
            open(target, "w").write("{nope")
            ci_reports.write_meta(reports, "lint", "summary", "pass", sha, "t", 0, "lint/summary.json")
        else:
            os.utime(target, (1_000_000_000, 1_000_000_000))
        assert gate(reports, root, sha) == 1, damage


def test_contract_stub_is_refused_once_the_contract_exists(tmp_path, repo):
    root, sha = repo
    reports = build(tmp_path, sha)
    assert gate(reports, root, sha) == 0
    os.makedirs(os.path.join(root, "packages", "contracts"))
    open(os.path.join(root, "packages", "contracts", "openapi.yaml"), "w").close()
    assert gate(reports, root, sha) == 1
