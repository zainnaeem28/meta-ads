"""Findings evaluator: one policy for every scanner report (standard library only).

Used by sast.sh, deps.sh, secrets.sh, container.sh, iac.sh and quality-gate.sh. Severity mapping, fail-on
thresholds, path classes and dismissals come from config/quality-policy.json and config/dispositions.json
(QUALITY-RELEASE-PLAN sections 5.1 to 5.4). A report that is missing, empty, malformed, from a crashed
scanner or in an unknown format is a tool failure, never a pass.

  evaluate_findings.py REPORT [--policy P] [--dispositions D] [--secrets] [--out FILE] [--today YYYY-MM-DD]

Exit 0: nothing blocks. Exit 1: a blocking finding or a tool failure. Exit 2: usage error.
"""

import argparse
import datetime
import json
import os
import re
import sys

ORDER = ["info", "low", "medium", "high", "critical"]
DEFAULT_POLICY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "config", "quality-policy.json")


class ToolFailure(Exception):
    """The report cannot be trusted: missing, empty, malformed or from a scanner that did not finish."""


def rank(severity):
    return ORDER.index(severity)


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as err:
        raise ToolFailure("%s '%s' cannot be read: %s" % (what, path, err))
    if not text.strip():
        raise ToolFailure("%s '%s' is empty" % (what, path))
    try:
        return json.loads(text)
    except ValueError as err:
        raise ToolFailure("%s '%s' is not valid JSON: %s" % (what, path, err))


def load_policy(path=None):
    policy = load_json(path or DEFAULT_POLICY, "policy")
    if not isinstance(policy, dict) or "severity" not in policy or "failOn" not in policy:
        raise ToolFailure("policy is missing 'severity' or 'failOn'")
    return policy


# ----- severity mapping -------------------------------------------------------------------------


def from_score(score, mapping):
    for name in ("critical", "high", "medium", "low"):
        if score >= mapping["cvss"][name]:
            return name
    return "info"


def from_text(value, policy):
    """Map a scanner word or SARIF level to a severity; None when the word is unknown."""
    sev = policy["severity"]
    text = str(value).strip().lower()
    if text in sev["words"]:
        return sev["words"][text]
    if text in sev["sarifLevel"]:
        return sev["sarifLevel"][text]
    return None


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def sarif_severity(result, rule, policy):
    props = result.get("properties") or {}
    rule_props = (rule or {}).get("properties") or {}
    score = number(props.get("security-severity"))
    if score is None:
        score = number(rule_props.get("security-severity"))
    if score is not None:
        return from_score(score, policy["severity"])
    level = result.get("level")
    if level is None:
        level = ((rule or {}).get("defaultConfiguration") or {}).get("level")
    if level is None:
        return policy["severity"]["missing"]
    return from_text(level, policy) or policy["severity"]["missing"]


# ----- parsers: each returns (tool, list of finding dicts) --------------------------------------


def finding(rule, severity, path, message, source, fingerprint=None):
    return {
        "rule": str(rule),
        "severity": severity,
        "path": path or "",
        "message": (message or "")[:300],
        "source": source,
        "fingerprint": fingerprint,
    }


def parse_sarif(doc, policy):
    findings = []
    tool_names = []
    for run in doc.get("runs") or []:
        driver = (run.get("tool") or {}).get("driver") or {}
        tool = driver.get("name") or "sarif"
        tool_names.append(tool)
        for inv in run.get("invocations") or []:
            if inv.get("executionSuccessful") is False:
                raise ToolFailure("%s reports executionSuccessful=false (the scan did not finish)" % tool)
        rules = {}
        for index, rule in enumerate(driver.get("rules") or []):
            rules[rule.get("id")] = rule
            rules[index] = rule
        for result in run.get("results") or []:
            rule_id = result.get("ruleId") or (result.get("rule") or {}).get("id") or "unknown"
            rule = rules.get(rule_id)
            if rule is None:
                rule = rules.get((result.get("rule") or {}).get("index"))
            locations = result.get("locations") or [{}]
            uri = (((locations[0] or {}).get("physicalLocation") or {}).get("artifactLocation") or {}).get("uri")
            fps = result.get("partialFingerprints") or result.get("fingerprints") or {}
            fingerprint = next(iter(fps.values()), None) if fps else None
            message = (result.get("message") or {}).get("text") or ""
            findings.append(
                finding(rule_id, sarif_severity(result, rule, policy), uri, message, tool.lower(), fingerprint)
            )
    if not doc.get("runs"):
        raise ToolFailure("SARIF has no runs (the scanner produced no result set)")
    return ", ".join(tool_names), findings


def parse_audit(doc, policy):
    findings = []
    if isinstance(doc.get("advisories"), dict):  # pnpm and npm 6 audit
        for key, adv in doc["advisories"].items():
            sev = from_text(adv.get("severity", ""), policy) or policy["severity"]["missing"]
            findings.append(
                finding(adv.get("github_advisory_id") or adv.get("id") or key, sev, adv.get("module_name"),
                        adv.get("title"), "audit")
            )
    else:  # npm 7+
        for name, vuln in (doc.get("vulnerabilities") or {}).items():
            sev = from_text(vuln.get("severity", ""), policy) or policy["severity"]["missing"]
            findings.append(finding("vulnerable-" + name, sev, name, vuln.get("name") or name, "audit"))
    return "audit", findings


def parse_trivy(doc, policy):
    findings = []
    for res in doc.get("Results") or []:
        target = res.get("Target")
        for vuln in res.get("Vulnerabilities") or []:
            sev = from_text(vuln.get("Severity", ""), policy) or policy["severity"]["missing"]
            findings.append(finding(vuln.get("VulnerabilityID"), sev, target, vuln.get("Title"), "trivy"))
        for mis in res.get("Misconfigurations") or []:
            sev = from_text(mis.get("Severity", ""), policy) or policy["severity"]["missing"]
            findings.append(finding(mis.get("ID"), sev, target, mis.get("Title"), "trivy"))
        for sec in res.get("Secrets") or []:
            findings.append(finding(sec.get("RuleID"), "critical", target, sec.get("Title"), "trivy"))
    return "trivy", findings


def parse_zap(doc, policy):
    findings = []
    codes = policy["severity"]["zapRiskCode"]
    for site in doc.get("site") or []:
        for alert in site.get("alerts") or []:
            sev = codes.get(str(alert.get("riskcode")), policy["severity"]["missing"])
            findings.append(finding(alert.get("pluginid") or alert.get("alert"), sev, site.get("@name"),
                                    alert.get("name"), "zap"))
    return "zap", findings


def parse_list(items, policy):
    findings = []
    for item in items:
        if not isinstance(item, dict):
            raise ToolFailure("findings list holds a non-object entry")
        raw = item.get("severity")
        sev = from_text(raw, policy) if raw is not None else None
        findings.append(
            finding(item.get("rule") or item.get("id") or "unknown", sev or policy["severity"]["missing"],
                    item.get("path") or item.get("file"), item.get("message"), item.get("source") or "list",
                    item.get("fingerprint"))
        )
    return "list", findings


def parse_report(path, policy):
    doc = load_json(path, "report")
    if isinstance(doc, list):
        return parse_list(doc, policy)
    if not isinstance(doc, dict):
        raise ToolFailure("report '%s' is neither an object nor a list" % path)
    if doc.get("error") or doc.get("Error"):
        raise ToolFailure("scanner error object: %s" % str(doc.get("error") or doc.get("Error"))[:200])
    if "runs" in doc and "version" in doc:
        return parse_sarif(doc, policy)
    if "advisories" in doc or "vulnerabilities" in doc:
        return parse_audit(doc, policy)
    if "Results" in doc or doc.get("SchemaVersion") is not None:
        return parse_trivy(doc, policy)
    if "site" in doc:
        return parse_zap(doc, policy)
    if isinstance(doc.get("findings"), list):
        return parse_list(doc["findings"], policy)
    raise ToolFailure("report '%s' has an unknown format" % path)


# ----- policy application -----------------------------------------------------------------------


def path_class(path, policy):
    for cls in policy["failOn"].get("pathClasses", []):
        for pattern in cls["paths"]:
            if re.search(pattern, path or ""):
                return cls
    return None


def effective(f, policy):
    """Return (severity after the project rule, threshold that applies to this finding)."""
    sev = f["severity"]
    threshold = policy["failOn"]["default"]
    cls = path_class(f["path"], policy)
    if cls:
        threshold = cls["failOn"]
        if rank(sev) >= rank(cls["failOn"]) and rank(sev) < rank(cls.get("promoteTo", sev)):
            sev = cls["promoteTo"]
    source_threshold = policy["failOn"].get("sources", {}).get(f["source"])
    if source_threshold and rank(source_threshold) < rank(threshold):
        threshold = source_threshold
    return sev, threshold


def load_dispositions(path, policy, today):
    """Return (entries, problems). An incomplete, expired or over-long entry is a problem, not a dismissal."""
    if not path or not os.path.isfile(path):
        return [], []
    doc = load_json(path, "dispositions")
    entries = doc.get("dispositions") if isinstance(doc, dict) else doc
    if not isinstance(entries, list):
        raise ToolFailure("dispositions file must hold a list")
    valid, problems = [], []
    limit = today + datetime.timedelta(days=policy["dispositions"]["maxDays"])
    for index, entry in enumerate(entries):
        label = "disposition #%d" % (index + 1)
        missing = [k for k in ("match", "reason", "owner", "expires") if not str(entry.get(k, "")).strip()]
        if missing:
            problems.append("%s is incomplete (missing %s)" % (label, ", ".join(missing)))
            continue
        try:
            expires = datetime.date.fromisoformat(entry["expires"])
        except ValueError:
            problems.append("%s has an invalid expiry '%s'" % (label, entry["expires"]))
            continue
        if expires < today:
            problems.append("%s (%s) expired on %s" % (label, entry["match"], entry["expires"]))
            continue
        if expires > limit:
            problems.append("%s (%s) expires after %d days" % (label, entry["match"], policy["dispositions"]["maxDays"]))
            continue
        valid.append(entry)
    return valid, problems


def dismissal_for(f, entries, policy):
    if f["severity"] in policy["dispositions"]["neverDismiss"]:
        return None
    for entry in entries:
        if entry["match"] not in (f["rule"], f["fingerprint"]):
            continue
        scope = entry.get("path")
        if scope and scope not in f["path"]:
            continue
        return entry
    return None


def evaluate(path, policy, dispositions_path=None, secrets=False, today=None):
    """Evaluate one report. Returns the result dict; result['ok'] is True when nothing blocks."""
    today = today or datetime.date.today()
    result = {"report": path, "tool": None, "ok": False, "blocking": [], "nonBlocking": [], "dismissed": [],
              "errors": []}
    try:
        tool, findings = parse_report(path, policy)
        entries, problems = load_dispositions(dispositions_path, policy, today)
    except ToolFailure as err:
        result["errors"].append(str(err))
        return result
    result["tool"] = tool
    result["errors"].extend(problems)
    due = today + datetime.timedelta(days=policy["nonBlocking"]["dueDays"])
    for f in findings:
        sev, threshold = effective(f, policy)
        item = dict(f, effectiveSeverity=sev, threshold=threshold)
        entry = dismissal_for(f, entries, policy)
        if secrets:
            blocks = True
        else:
            blocks = rank(sev) >= rank(threshold)
        if entry and blocks:
            item["dismissedBy"] = {"owner": entry["owner"], "expires": entry["expires"], "reason": entry["reason"]}
            result["dismissed"].append(item)
        elif blocks:
            result["blocking"].append(item)
        else:
            item["owner"] = policy["nonBlocking"]["owner"]
            item["due"] = due.isoformat()
            result["nonBlocking"].append(item)
    result["ok"] = not result["blocking"] and not result["errors"]
    return result


def summarize(result):
    lines = []
    for err in result["errors"]:
        lines.append("TOOL FAILURE: " + err)
    for f in result["blocking"]:
        lines.append("BLOCKING %s %s at %s (%s)" % (f["effectiveSeverity"].upper(), f["rule"], f["path"] or "-",
                                                    f["source"]))
    for f in result["dismissed"]:
        lines.append("dismissed %s %s (owner %s, expires %s)" % (f["severity"], f["rule"], f["dismissedBy"]["owner"],
                                                                f["dismissedBy"]["expires"]))
    for f in result["nonBlocking"]:
        lines.append("recorded %s %s owner=%s due=%s" % (f["severity"], f["rule"], f["owner"], f["due"]))
    lines.append("RESULT %s: %d blocking, %d recorded, %d dismissed, %d tool failures" % (
        "PASS" if result["ok"] else "FAIL", len(result["blocking"]), len(result["nonBlocking"]),
        len(result["dismissed"]), len(result["errors"])))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("report")
    parser.add_argument("--policy", default=DEFAULT_POLICY)
    parser.add_argument("--dispositions", default=None)
    parser.add_argument("--secrets", action="store_true", help="every finding blocks, whatever its severity")
    parser.add_argument("--out", default=None, help="write the normalized result JSON here")
    parser.add_argument("--today", default=None)
    args = parser.parse_args(argv)
    try:
        policy = load_policy(args.policy)
        today = datetime.date.fromisoformat(args.today) if args.today else None
    except (ToolFailure, ValueError) as err:
        sys.stderr.write("evaluate_findings: %s\n" % err)
        return 2
    result = evaluate(args.report, policy, args.dispositions, args.secrets, today)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)
            handle.write("\n")
    print(summarize(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
