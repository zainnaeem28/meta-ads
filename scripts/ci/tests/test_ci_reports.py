import json
import os
import subprocess

import pytest

import ci_reports


def test_write_and_read_meta_roundtrip(tmp_path):
    (tmp_path / "x").mkdir()
    (tmp_path / "x" / "r.json").write_text("{}")
    meta = ci_reports.write_meta(str(tmp_path), "x", "summary", "pass", "abc", "tool", 0, "x/r.json")
    assert meta["reportSha256"] == ci_reports.sha256_file(str(tmp_path / "x" / "r.json"))
    read, problem = ci_reports.read_meta(str(tmp_path), "x")
    assert problem is None and read["sourceSha"] == "abc"


def test_meta_without_report_file_has_no_hash(tmp_path):
    meta = ci_reports.write_meta(str(tmp_path), "y", "summary", "stub", "abc", report="missing.json")
    assert meta["reportSha256"] is None


def test_unknown_status_is_rejected(tmp_path):
    with pytest.raises(ValueError):
        ci_reports.write_meta(str(tmp_path), "x", "summary", "great", "abc")


def test_read_meta_problems(tmp_path):
    assert ci_reports.read_meta(str(tmp_path), "none")[1].startswith("no meta file")
    path = ci_reports.meta_path(str(tmp_path), "bad")
    os.makedirs(os.path.dirname(path))
    with open(path, "w") as handle:
        handle.write("{broken")
    assert "unreadable" in ci_reports.read_meta(str(tmp_path), "bad")[1]
    with open(path, "w") as handle:
        json.dump({"status": "great"}, handle)
    assert "malformed" in ci_reports.read_meta(str(tmp_path), "bad")[1]


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def test_source_sha_prefers_environment_then_git(tmp_path, monkeypatch):
    monkeypatch.delenv("CI_SOURCE_SHA", raising=False)
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    git(tmp_path, "init", "-q")
    (tmp_path / "f").write_text("1")
    git(tmp_path, "add", "f")
    git(tmp_path, "commit", "-q", "-m", "one")
    head = subprocess.run(["git", "-C", str(tmp_path), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert ci_reports.source_sha(str(tmp_path)) == head
    assert isinstance(ci_reports.commit_time(str(tmp_path), head), int)
    assert ci_reports.commit_time(str(tmp_path), "0" * 40) is None
    monkeypatch.setenv("GITHUB_SHA", "g" * 40)
    assert ci_reports.source_sha(str(tmp_path)) == "g" * 40
    monkeypatch.setenv("CI_SOURCE_SHA", "c" * 40)
    assert ci_reports.source_sha(str(tmp_path)) == "c" * 40


def test_source_sha_outside_a_repository_fails(tmp_path, monkeypatch):
    monkeypatch.delenv("CI_SOURCE_SHA", raising=False)
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    with pytest.raises(RuntimeError):
        ci_reports.source_sha(str(tmp_path))


def test_cli_writes_meta_and_rejects_bad_usage(tmp_path, capsys):
    argv = ["write", str(tmp_path), "lint", "summary", "pass", "abc", "eslint", "0"]
    assert ci_reports._cli(argv) == 0
    assert ci_reports.read_meta(str(tmp_path), "lint")[0]["tool"] == "eslint"
    assert ci_reports._cli(argv + ["", "why"]) == 0
    assert ci_reports._cli(["write"]) == 2
    assert "usage" in capsys.readouterr().err
