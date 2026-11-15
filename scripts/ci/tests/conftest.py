import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import pytest  # noqa: E402

import evaluate_findings  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GATE = os.path.join(ROOT, "scripts", "ci", "probes", "gate")


@pytest.fixture(scope="session")
def policy():
    return evaluate_findings.load_policy(os.path.join(ROOT, "config", "quality-policy.json"))


@pytest.fixture
def write_json(tmp_path):
    def write(name, doc):
        path = tmp_path / name
        path.write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")
        return str(path)

    return write


def sarif(results, rules=None, ok=True, tool="t"):
    return {
        "version": "2.1.0",
        "runs": [
            {
                "tool": {"driver": {"name": tool, "rules": rules or []}},
                "invocations": [{"executionSuccessful": ok}],
                "results": results,
            }
        ],
    }


def result(rule="R1", level=None, uri="apps/web/x.ts", props=None, fp=None):
    item = {"ruleId": rule, "message": {"text": "m"},
            "locations": [{"physicalLocation": {"artifactLocation": {"uri": uri}}}]}
    if level:
        item["level"] = level
    if props:
        item["properties"] = props
    if fp:
        item["partialFingerprints"] = {"k": fp}
    return item
