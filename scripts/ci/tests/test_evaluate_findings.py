import datetime
import json

import pytest
from conftest import result, sarif

import evaluate_findings as ef

TODAY = datetime.date(2026, 11, 15)


def run(policy, path, **kw):
    return ef.evaluate(path, policy, today=TODAY, **kw)


def test_cvss_scores_map_to_severities(policy):
    cases = {"9.8": "critical", "7.0": "high", "6.9": "medium", "4.0": "medium", "0.1": "low", "0": "info"}
    for score, expected in cases.items():
        assert ef.sarif_severity({"properties": {"security-severity": score}}, None, policy) == expected


def test_sarif_level_and_missing_severity(policy):
    assert ef.sarif_severity({"level": "error"}, None, policy) == "high"
    assert ef.sarif_severity({"level": "warning"}, None, policy) == "medium"
    assert ef.sarif_severity({"level": "note"}, None, policy) == "low"
    assert ef.sarif_severity({"level": "none"}, None, policy) == "info"
    assert ef.sarif_severity({}, None, policy) == "high"
    assert ef.sarif_severity({"level": "bogus"}, None, policy) == "high"
    rule = {"defaultConfiguration": {"level": "note"}, "properties": {}}
    assert ef.sarif_severity({}, rule, policy) == "low"
    rule = {"properties": {"security-severity": "9.1"}}
    assert ef.sarif_severity({}, rule, policy) == "critical"


def test_scanner_words(policy):
    assert ef.from_text("Moderate", policy) == "medium"
    assert ef.from_text("NEGLIGIBLE", policy) == "info"
    assert ef.from_text("weird", policy) is None


def test_clean_report_passes(policy, write_json):
    out = run(policy, write_json("a.sarif", sarif([])))
    assert out["ok"] and not out["blocking"]
    assert "RESULT PASS" in ef.summarize(out)


def test_high_blocks_and_medium_is_recorded_with_owner_and_due(policy, write_json):
    doc = sarif([result("H", "error"), result("M", "warning"), result("L", "note", uri="")])
    out = run(policy, write_json("a.sarif", doc))
    assert not out["ok"]
    assert [f["rule"] for f in out["blocking"]] == ["H"]
    assert {f["rule"] for f in out["nonBlocking"]} == {"M", "L"}
    assert all(f["owner"] and f["due"] == "2026-12-15" for f in out["nonBlocking"])
    assert "BLOCKING HIGH H" in ef.summarize(out)


def test_key_custody_paths_promote_medium_to_high(policy, write_json):
    doc = sarif([result("M", "warning", uri="apps/api/src/modules/provider-keys/infrastructure/x.ts")])
    out = run(policy, write_json("a.sarif", doc))
    assert not out["ok"]
    assert out["blocking"][0]["effectiveSeverity"] == "high"
    doc = sarif([result("L", "note", uri="apps/api/src/modules/provider-keys/infrastructure/x.ts")])
    assert run(policy, write_json("b.sarif", doc))["ok"]
    doc = sarif([result("C", props={"security-severity": "9.9"}, uri="apps/api/src/platform/egress/x.ts")])
    assert run(policy, write_json("c.sarif", doc))["blocking"][0]["effectiveSeverity"] == "critical"


def test_secrets_block_whatever_the_severity(policy, write_json):
    out = run(policy, write_json("a.sarif", sarif([result("S", "note")])), secrets=True)
    assert not out["ok"]


def test_crashed_scanner_and_unknown_formats_are_tool_failures(policy, write_json):
    assert not run(policy, write_json("a.sarif", sarif([], ok=False)))["ok"]
    assert not run(policy, write_json("b.sarif", '{"version": "2.1.0", "runs": []}'))["ok"]
    assert not run(policy, write_json("c.json", {"error": "boom"}))["ok"]
    assert not run(policy, write_json("d.json", {"hello": 1}))["ok"]
    assert not run(policy, write_json("e.json", ""))["ok"]
    assert not run(policy, write_json("f.json", "{not json"))["ok"]
    assert not run(policy, write_json("g.json", "42"))["ok"]
    assert not run(policy, str(write_json("h.json", "{}") + ".missing"))["ok"]
    assert not run(policy, write_json("i.json", [1]))["ok"]
    assert "TOOL FAILURE" in ef.summarize(run(policy, write_json("j.json", "{not json")))


def test_audit_trivy_zap_and_list_formats(policy, write_json):
    pnpm = {"advisories": {"1": {"severity": "high", "module_name": "left-pad", "title": "t", "id": 1},
                           "2": {"severity": "low", "module_name": "x", "github_advisory_id": "GHSA-x"}}}
    out = run(policy, write_json("a.json", pnpm))
    assert [f["path"] for f in out["blocking"]] == ["left-pad"] and len(out["nonBlocking"]) == 1
    npm = {"vulnerabilities": {"pkg": {"severity": "critical", "name": "pkg"}}}
    assert not run(policy, write_json("b.json", npm))["ok"]
    trivy = {"SchemaVersion": 2, "Results": [{"Target": "img", "Vulnerabilities": [
        {"VulnerabilityID": "CVE-1", "Severity": "CRITICAL", "Title": "t"}],
        "Misconfigurations": [{"ID": "DS001", "Severity": "LOW", "Title": "t"}],
        "Secrets": [{"RuleID": "aws", "Title": "t"}]}]}
    out = run(policy, write_json("c.json", trivy))
    assert len(out["blocking"]) == 2 and len(out["nonBlocking"]) == 1
    zap = {"site": [{"@name": "http://app", "alerts": [{"pluginid": "10020", "riskcode": "2", "name": "n"},
                                                       {"pluginid": "1", "riskcode": "1", "name": "n"}]}]}
    out = run(policy, write_json("d.json", zap))
    assert [f["rule"] for f in out["blocking"]] == ["10020"]  # ZAP fails on medium
    out = run(policy, write_json("e.json", {"findings": [{"rule": "x", "severity": "medium", "path": "p"},
                                                          {"id": "y"}, {"file": "f", "severity": "weird"}]}))
    assert len(out["blocking"]) == 2 and len(out["nonBlocking"]) == 1


def dispositions(write_json, entries):
    return write_json("d.json", {"dispositions": entries})


def entry(**kw):
    base = {"match": "H", "reason": "false positive: generated code", "owner": "Security Reviewer",
            "expires": "2026-12-31"}
    base.update(kw)
    return base


def test_valid_disposition_dismisses_a_high(policy, write_json):
    report = write_json("a.sarif", sarif([result("H", "error", uri="apps/web/gen/x.ts")]))
    out = run(policy, report, dispositions_path=dispositions(write_json, [entry(path="gen/")]))
    assert out["ok"] and out["dismissed"][0]["dismissedBy"]["owner"] == "Security Reviewer"
    assert "dismissed high H" in ef.summarize(out)


def test_disposition_scoped_to_another_path_does_not_apply(policy, write_json):
    report = write_json("a.sarif", sarif([result("H", "error", uri="apps/web/x.ts")]))
    out = run(policy, report, dispositions_path=dispositions(write_json, [entry(path="elsewhere/")]))
    assert not out["ok"]


def test_disposition_matches_fingerprints(policy, write_json):
    report = write_json("a.sarif", sarif([result("H", "error", fp="abc123")]))
    assert run(policy, report, dispositions_path=dispositions(write_json, [entry(match="abc123")]))["ok"]


def test_critical_is_never_dismissed(policy, write_json):
    report = write_json("a.sarif", sarif([result("H", props={"security-severity": "9.5"})]))
    assert not run(policy, report, dispositions_path=dispositions(write_json, [entry()]))["ok"]


@pytest.mark.parametrize(
    "bad",
    [
        entry(expires="2026-01-01"),
        entry(expires="2027-06-01"),
        entry(expires="soon"),
        entry(owner=""),
    ],
)
def test_bad_dispositions_fail_instead_of_dismissing(policy, write_json, bad):
    report = write_json("a.sarif", sarif([result("H", "error")]))
    out = run(policy, report, dispositions_path=dispositions(write_json, [bad]))
    assert not out["ok"] and out["errors"] and out["blocking"]


def test_dispositions_file_shapes(policy, write_json, tmp_path):
    report = write_json("a.sarif", sarif([]))
    assert run(policy, report, dispositions_path=str(tmp_path / "none.json"))["ok"]
    assert run(policy, report, dispositions_path=write_json("d.json", []))["ok"]
    assert not run(policy, report, dispositions_path=write_json("e.json", {"dispositions": 3}))["ok"]


def test_load_policy_rejects_incomplete_policy(write_json):
    with pytest.raises(ef.ToolFailure):
        ef.load_policy(write_json("p.json", {"nope": 1}))


def test_cli(policy, write_json, tmp_path, capsys):
    report = write_json("a.sarif", sarif([result("H", "error")]))
    out_file = tmp_path / "sub" / "out.json"
    code = ef.main([report, "--out", str(out_file), "--today", "2026-11-15"])
    assert code == 1 and json.loads(out_file.read_text())["blocking"]
    assert "BLOCKING" in capsys.readouterr().out
    assert ef.main([write_json("b.sarif", sarif([]))]) == 0
    assert ef.main([report, "--policy", str(tmp_path / "missing.json")]) == 2
    assert ef.main([report, "--today", "yesterday"]) == 2
