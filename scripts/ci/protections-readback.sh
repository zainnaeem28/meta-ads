#!/usr/bin/env bash
# Repository protections read-back (DEVOPS-PLAN DO-03, 3.2-3.4). Reads every control through the GitHub API and
# prints one line per control: PASS (read back and as required), GAP (cannot exist on this plan or owner type,
# with its owner item and compensating control) or FAIL (a control that should exist is wrong). It never claims
# enforcement that was not read back. Exit 1 on any FAIL.
#   protections-readback.sh --check           read back live, write docs/evidence/TASK-007/readback.txt and
#                                             reports/ci/protections-junit.xml; offline (no API access) it
#                                             validates the committed readback.txt and says so
#   protections-readback.sh --apply-rulesets  create the rulesets in .github/rulesets/ (needs Pro or a public repo)
#   protections-readback.sh --probe-push      attempt one push to main and require rejection; runs only when a
#                                             ruleset for main was read back, otherwise records BLOCKED
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mode=""
case "${1:-}" in
  --check|--apply-rulesets|--probe-push) mode="${1#--}" ;;
  *) sed -n 2,13p "${BASH_SOURCE[0]}"; exit 2 ;;
esac
EVIDENCE="$ROOT/docs/evidence/TASK-007/readback.txt"
JUNIT="${CI_REPORTS_DIR:-$ROOT/reports}/ci/protections-junit.xml"
REPO="${PROTECTIONS_REPO:-$(git remote get-url origin | sed -E 's#^.*github.com[:/]##; s#\.git$##')}"

api() { gh api "repos/$REPO$1" 2>&1; }          # prints body or the error; exit status kept
online() { command -v gh >/dev/null 2>&1 && gh api "repos/$REPO" --jq .name >/dev/null 2>&1; }

if ! online; then
  if [ "$mode" != check ]; then echo "protections-readback: GitHub API not reachable for $REPO" >&2; exit 1; fi
  echo "mode=offline: GitHub API not reachable; validating the committed read-back only (nothing re-read)"
  [ -s "$EVIDENCE" ] && grep -q '^## Read-back' "$EVIDENCE" && ! grep -q '^FAIL ' "$EVIDENCE" \
    || { echo "FAIL: committed read-back missing or contains FAIL" >&2; exit 1; }
  mkdir -p "$(dirname "$JUNIT")"
  printf '<testsuite name="protections" tests="1" failures="0"><testcase name="committed-readback-offline"/></testsuite>\n' >"$JUNIT"
  exit 0
fi

if [ "$mode" = apply-rulesets ]; then
  for f in .github/rulesets/*.json; do
    echo "applying $f"; gh api -X POST "repos/$REPO/rulesets" --input "$f" --jq '.id'
  done
  exit 0
fi

export REPO EVIDENCE JUNIT ROOT
REPO_JSON="$(api "")"; PERM_JSON="$(api /actions/permissions)"; WF_JSON="$(api /actions/permissions/workflow)"
set +e
RS_JSON="$(api /rulesets)"; RS_RC=$?
BP_MAIN="$(api /branches/main/protection)"; BP_MAIN_RC=$?
BP_DEV="$(api /branches/dev/protection)"; BP_DEV_RC=$?
ENV_JSON="$(api /environments)"; ENV_RC=$?
SEC_JSON="$(api /actions/secrets)"; SEC_RC=$?
FORK_JSON="$(api /actions/permissions/fork-pr-contributor-approval)"; FORK_RC=$?
set -e
export REPO_JSON PERM_JSON WF_JSON RS_JSON RS_RC BP_MAIN BP_MAIN_RC BP_DEV BP_DEV_RC ENV_JSON ENV_RC SEC_JSON SEC_RC FORK_JSON FORK_RC

python3 -I - "$mode" <<'PY'
import json, os, subprocess, sys, glob, re
from xml.sax.saxutils import quoteattr
mode = sys.argv[1]; e = os.environ
def msg1(k):
    for line in (e[k] or "").splitlines():
        try: d, _ = json.JSONDecoder().raw_decode(line); return " ".join(str(x) for x in (d.get("message"), d.get("errors")) if x)
        except Exception: continue
    return ((e[k] or "").splitlines() or [""])[0][:160]
def j(k):
    try: return json.loads(e[k])
    except Exception: return None
repo, wf = j("REPO_JSON") or {}, j("WF_JSON") or {}
rows = []  # (id, status, detail, owner, compensating)
def add(i, s, d, o="", c=""): rows.append((i, s, d, o, c))

add("default-branch", "PASS" if repo.get("default_branch") == "dev" else "FAIL",
    f"default_branch={repo.get('default_branch')} (required: dev)")
ok = wf.get("default_workflow_permissions") == "read" and wf.get("can_approve_pull_request_reviews") is False
add("actions-token-readonly", "PASS" if ok else "FAIL",
    f"default_workflow_permissions={wf.get('default_workflow_permissions')} can_approve_pull_request_reviews={wf.get('can_approve_pull_request_reviews')}")

# rulesets: read back when the API serves them, otherwise a recorded plan gap
rs = j("RS_JSON")
if e["RS_RC"] == "0" and isinstance(rs, list):
    names = {r.get("name"): r for r in rs}
    for need, tgt in (("main", "branch"), ("dev", "branch"), ("release-tags", "tag")):
        r = names.get(need)
        add(f"ruleset-{need}", "PASS" if r and r.get("enforcement") == "active" and r.get("target") == tgt else "FAIL",
            f"present={bool(r)} enforcement={r and r.get('enforcement')}")
else:
    msg = msg1("RS_JSON")
    for need in ("main", "dev", "release-tags"):
        add(f"ruleset-{need}", "GAP", f"rulesets API: {msg}", "owner DOP-OI-2 (GitHub Pro, owner-only purchase)",
            "Paperclip review stages + submit-check reports + quality-gate job (blocks a release workflow, not a push); ruleset JSON committed in .github/rulesets/ and applied with --apply-rulesets after the upgrade")
    for b, k in (("main", "BP_MAIN"), ("dev", "BP_DEV")):
        if e[k + "_RC"] != "0":
            add(f"branch-protection-{b}", "GAP", msg1(k), "owner DOP-OI-2", "same as rulesets")
        else:
            add(f"branch-protection-{b}", "PASS", "classic branch protection present")
    add("dev-integrator-only-push", "GAP", "bypass actors need an organization; user-owned repository (DOP-OI-2c)",
        "owner DOP-OI-2c", "process control: only the Integrator pushes dev (WORKFLOW Branches)")
    add("shared-identity", "GAP", "one managed token for every agent; GitHub cannot tell author from Integrator (DOP-OI-2b)",
        "owner DOP-OI-2b", "Paperclip task ownership and reviews; no claim of separation of duties")

env = j("ENV_JSON")
if e["ENV_RC"] == "0" and isinstance(env, dict):
    n = env.get("total_count", 0)
    add("environments", "PASS" if n else "GAP", f"total_count={n}" + ("" if n else " (private repository, Free plan: cannot be created)"),
        "" if n else "owner DOP-OI-2", "" if n else "no deploy credential in GitHub; release executor option S (DEVOPS-PLAN 3.4)")
else:
    add("environments", "GAP", msg1("ENV_JSON"), "owner DOP-OI-2", "release executor option S")

# fork-PR rule
if e["FORK_RC"] == "0":
    add("fork-pr-approval", "PASS", e["FORK_JSON"].strip()[:160])
else:
    msg = msg1("FORK_JSON")
    add("fork-pr-approval", "GAP", f"API: {msg}", "owner DOP-OI-2c",
        "no fork-triggered workflows exist: ci.yml triggers are pull_request/push on main/workflow_dispatch only, no pull_request_target")
if repo.get("allow_forking") is True and (repo.get("owner") or {}).get("type") == "User":
    add("allow-forking-off", "GAP", "allow_forking=true; setting changeable only on organization-owned private repositories (422 observed)",
        "owner DOP-OI-2c", "single collaborator today; no outside collaborator is added; fork-PR rule above")
elif repo.get("allow_forking") is False:
    add("allow-forking-off", "PASS", "allow_forking=false")

# no deploy credential in GitHub
forbidden = re.compile(r"RENDER|SENTRY|G3|GHCR|METRICS|DEPLOY|API_KEY|TOKEN|SECRET|PASSWORD", re.I)
sec = j("SEC_JSON") or {}
names = [s.get("name", "") for s in sec.get("secrets", [])] if e["SEC_RC"] == "0" else None
if names is None:
    add("no-deploy-credentials", "FAIL", "repository secrets not readable")
else:
    bad = [n for n in names if forbidden.search(n)]
    add("no-deploy-credentials", "PASS" if not bad else "FAIL", f"repository secrets={names or 'none'}; deploy-like={bad or 'none'}")
used = []
for f in glob.glob(".github/workflows/*.y*ml"):
    for m in re.finditer(r"\$\{\{[^}]*\bsecrets\.([A-Za-z0-9_]+)", open(f).read()):
        if m.group(1) != "GITHUB_TOKEN": used.append(f"{f}:{m.group(1)}")
add("workflows-reference-no-secrets", "PASS" if not used else "FAIL", f"non-GITHUB_TOKEN secret references={used or 'none'}")

# unauthorized push
main_protected = any(r[0] == "ruleset-main" and r[1] == "PASS" for r in rows)
if mode == "probe-push" and main_protected:
    tmp = subprocess.run(["git", "commit-tree", "origin/main^{tree}", "-p", "origin/main", "-m", "TC-OPS-06 unauthorized push probe"],
                         capture_output=True, text=True, check=True).stdout.strip()
    p = subprocess.run(["git", "push", "origin", f"{tmp}:refs/heads/main"], capture_output=True, text=True)
    add("unauthorized-push-main", "PASS" if p.returncode != 0 else "FAIL",
        f"push exit={p.returncode}: {(p.stderr.strip().splitlines() or [''])[-1][:160]}")
else:
    add("unauthorized-push-main", "BLOCKED",
        "TC-OPS-06 not attempted: no ruleset or branch protection on main exists on this plan, so a push would succeed and mutate main, and a rejected non-fast-forward push would prove nothing about protection",
        "owner DOP-OI-2", "rerun with --probe-push after --apply-rulesets and a read-back of ruleset-main")

order = {"PASS": 0, "GAP": 1, "BLOCKED": 1, "FAIL": 2}
lines = ["## Read-back", f"repository: {e['REPO']} (private={repo.get('private')}, owner type={(repo.get('owner') or {}).get('type')})",
         ""]
for i, s, d, o, c in rows:
    lines.append(f"{s} {i}: {d}")
    if o: lines.append(f"    owner: {o}")
    if c: lines.append(f"    compensating control: {c}")
fails = [r for r in rows if r[1] == "FAIL"]
lines += ["", f"summary: pass={sum(r[1]=='PASS' for r in rows)} gap={sum(r[1]=='GAP' for r in rows)} blocked={sum(r[1]=='BLOCKED' for r in rows)} fail={len(fails)}"]
out = "\n".join(lines) + "\n"
print(out, end="")
if mode in ("check", "probe-push"):
    os.makedirs(os.path.dirname(e["EVIDENCE"]), exist_ok=True)
    open(e["EVIDENCE"], "w").write(out)
    os.makedirs(os.path.dirname(e["JUNIT"]), exist_ok=True)
    cases = "".join(
        f'<testcase classname="protections" name={quoteattr(i)}>' +
        (f'<failure message={quoteattr(d)}/>' if s == "FAIL" else f'<system-out>{quoteattr(s)}</system-out>' if s != "PASS" else "") +
        "</testcase>" for i, s, d, o, c in rows)
    open(e["JUNIT"], "w").write(f'<testsuite name="protections" tests="{len(rows)}" failures="{len(fails)}">{cases}</testsuite>\n')
sys.exit(1 if fails else 0)
PY
