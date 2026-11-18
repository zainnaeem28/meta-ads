#!/usr/bin/env bash
# TASK-115 proof run (TC-LOG-02): every custom Semgrep rule blocks its positive fixture and passes its negative
# fixture; a canary secret is blocked by the secret scanner in a commit, in history and in a built bundle, through
# the real wrappers; the scan of the tree itself is clean; the host push protection is read back (or the gap is
# recorded). Writes reports/security/junit.xml, reports/sast.sarif and reports/secrets.sarif (the tree scans).
# The canary is generated here at run time and never written to a tracked file or printed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
export CI="${CI:-1}"
export PATH="${CI_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/shroomap-ci-tools}/bin:${CI_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/shroomap-ci-tools}/venv/bin:$PATH"
"$ROOT/scripts/ci/install-tools.sh" semgrep gitleaks >/dev/null || { echo "cannot install semgrep and gitleaks" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RESULTS="$WORK/results.tsv"; : >"$RESULTS"
FAILED=0
# check NAME STATUS DETAIL: record one test case (STATUS is pass or fail).
check() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$RESULTS"
  if [ "$2" = pass ]; then printf 'PASS  %-62s %s\n' "$1" "$3"; else printf 'FAIL  %-62s %s\n' "$1" "$3"; FAILED=$((FAILED + 1)); fi
}

has_blocking() { python3 -I -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))['blocking'] else 1)" "$1" 2>/dev/null; }

# ---- 1. Semgrep rule fixtures --------------------------------------------------------------------------------
FIX="$HERE/fixtures"
semgrep scan --config "$ROOT/config/semgrep" --json --output "$WORK/fixtures.json" --metrics off --disable-version-check \
  --quiet "$FIX" >/dev/null 2>"$WORK/semgrep.err"; src=$?
if [ "$src" -ne 0 ] && [ "$src" -ne 1 ]; then check "semgrep ran over the rule fixtures" fail "exit $src"; cat "$WORK/semgrep.err" >&2
else
  python3 -I - "$FIX" "$WORK/fixtures.json" "$ROOT/config/semgrep/shroomap-security.yml" "$RESULTS" <<'PY' || FAILED=$((FAILED + 1))
import json, os, re, sys
fix, report, rules_file, results = sys.argv[1:5]
doc = json.load(open(report))
hits = {}
for r in doc["results"]:
    hits.setdefault(os.path.realpath(r["path"]), set()).add(r["check_id"].split("shroomap.", 1)[1])
errors = [e for e in doc["errors"] if e.get("level") == "error"]
rule_ids = re.findall(r"^  - id: shroomap\.(\S+)$", open(rules_file).read(), re.M)
bad = 0
out = open(results, "a")
def check(name, ok, detail):
    global bad
    out.write("%s\t%s\t%s\n" % (name, "pass" if ok else "fail", detail))
    print("%s  %-62s %s" % ("PASS" if ok else "FAIL", name, detail))
    bad += 0 if ok else 1
check("semgrep rules parse and run without errors", not errors, "%d rule(s), %d error(s)" % (len(rule_ids), len(errors)))
covered_pos, covered_neg = set(), set()
for kind in ("positive", "negative"):
    for base, _, files in os.walk(os.path.join(fix, kind)):
        for f in files:
            path = os.path.join(base, f)
            head = open(path).readline().strip()
            expect = head.split("expect:", 1)[1].strip() if "expect:" in head else None
            rel = os.path.relpath(path, fix)
            found = hits.get(os.path.realpath(path), set())
            if kind == "positive":
                short = expect.split("shroomap.", 1)[-1] if expect else ""
                ok = short in found
                covered_pos.add(short)
                check("positive fixture is blocked: " + rel, ok, "expected %s, found %s" % (short, sorted(found) or "nothing"))
            else:
                covered_neg.add(rel)
                check("negative fixture passes: " + rel, not found, "findings: %s" % (sorted(found) or "none"))
neg_rules = set()
for rid in rule_ids:
    check("rule has a positive fixture: " + rid, rid in covered_pos, "")
# every rule needs a negative fixture too: the negatives are named per rule family in the fixture header.
fam = {"key-custody.no-withdecryptedkey-outside-worker": "bootstrap/worker", "egress.no-raw-http-outside-platform-egress": "platform/egress",
       "sql.no-interpolated-identifiers": "shrooms/repo", "process.no-shell-string-spawn": "media/run",
       "key-custody.no-unprojected-provider-keys-select": "keys/list"}
for rid in rule_ids:
    ok = any(fam.get(rid, "\0") in n for n in covered_neg)
    check("rule has a negative fixture: " + rid, ok, fam.get(rid, "no mapping"))
sys.exit(1 if bad else 0)
PY
fi

# ---- 2. The same rules through the real SAST wrapper, on the committed fixtures and on the tree --------------
export CI_REPORTS_DIR="$WORK/wrap-fixture"
SAST_TARGETS="scripts/ci/security/fixtures/positive" SAST_INCLUDE_FIXTURES=1 "$HERE/sast-custom.sh" >"$WORK/sast-fixture.log" 2>&1; rc=$?
[ "$rc" -ne 0 ] && has_blocking "$WORK/wrap-fixture/findings/sast.json" \
  && check "sast wrapper blocks the positive fixtures" pass "exit $rc" || check "sast wrapper blocks the positive fixtures" fail "exit $rc"
SAST_TARGETS="scripts/ci/security/fixtures/negative" SAST_INCLUDE_FIXTURES=1 "$HERE/sast-custom.sh" >"$WORK/sast-neg.log" 2>&1; rc=$?
[ "$rc" -eq 0 ] && check "sast wrapper passes the negative fixtures" pass "exit 0" || { check "sast wrapper passes the negative fixtures" fail "exit $rc"; tail -5 "$WORK/sast-neg.log"; }
unset CI_REPORTS_DIR

# ---- 3. Canary secret: commit, history, built bundle -------------------------------------------------------------
OPENAI_CANARY="sk-proj-$(python3 -I -c "import secrets,string;print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(48)))")"
WAVE_CANARY="ws-$(python3 -I -c "import secrets,string;print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(40)))")"
REPO="$WORK/canary-repo"
git init -q "$REPO"
git -C "$REPO" config user.email canary@example.test; git -C "$REPO" config user.name canary
printf 'export const note = "clean";\n' >"$REPO/clean.ts"
git -C "$REPO" add . && git -C "$REPO" commit -q -m "clean"
# Stub fixture keys must pass: they are the shapes the provider stubs use.
printf 'const a = "sk-stub-valid-key-000000000000"; const b = "ws-stub-valid-key-000000000000";\n' >"$REPO/stub.ts"
git -C "$REPO" add . && git -C "$REPO" commit -q -m "stub keys"
scan_repo() { # LABEL EXPECT(blocked|clean) RANGE
  local label="$1" expect="$2" range="$3" rc
  CI_REPORTS_DIR="$WORK/wrap-$label" SECRETS_REPO="$REPO" CI_SECRETS_RANGE="$range" CI_SECRETS_FULL="${4:-}" \
    "$HERE/secrets-custom.sh" >"$WORK/$label.log" 2>&1; rc=$?
  if [ "$expect" = blocked ]; then
    if [ "$rc" -ne 0 ] && has_blocking "$WORK/wrap-$label/findings/secrets.json"; then
      check "$label" pass "wrapper exit $rc, finding read from reports/secrets.sarif by the policy evaluator"
    else check "$label" fail "wrapper exit $rc (expected a blocking secret finding)"; tail -5 "$WORK/$label.log"; fi
  else
    [ "$rc" -eq 0 ] && check "$label" pass "wrapper exit 0" || { check "$label" fail "wrapper exit $rc"; tail -5 "$WORK/$label.log"; }
  fi
}
scan_repo "stub fixture keys are not flagged" clean "" 1
base="$(git -C "$REPO" rev-parse HEAD)"
printf 'export const k = "%s";\n' "$OPENAI_CANARY" >"$REPO/leak.ts"
printf 'export const w = "%s";\n' "$WAVE_CANARY" >"$REPO/leak2.ts"
git -C "$REPO" add . && git -C "$REPO" commit -q -m "canary"
scan_repo "canary secret in a commit is blocked" blocked "$base..HEAD"
git -C "$REPO" rm -q leak.ts leak2.ts && git -C "$REPO" commit -q -m "remove canary from the tree"
scan_repo "canary secret removed from the tree but present in history is blocked" blocked "" 1
for which in openai wavespeed; do
  rid=openai-key-shaped; [ "$which" = wavespeed ] && rid=wavespeed-key-prefixed
  grep -q "$rid" "$WORK/wrap-canary secret removed from the tree but present in history is blocked/secrets.sarif" 2>/dev/null \
    && check "custom pattern fires on the $which canary: $rid" pass "" || check "custom pattern fires on the $which canary: $rid" fail "rule id not in the report"
done
# Built bundle: a minified-looking client chunk.
BUNDLE="$WORK/bundle/static/chunks"; mkdir -p "$BUNDLE"
printf '!function(){var a="x";window.__cfg={key:"%s"}}();\n' "$OPENAI_CANARY" >"$BUNDLE/main-abc123.js"
"$HERE/bundle-scan.sh" "$WORK/bundle" "$WORK/bundle.sarif" >"$WORK/bundle.log" 2>&1; rc=$?
[ "$rc" -eq 1 ] && check "canary secret in a built bundle is blocked" pass "bundle-scan exit 1" || { check "canary secret in a built bundle is blocked" fail "bundle-scan exit $rc"; tail -3 "$WORK/bundle.log"; }
printf '!function(){var a="x"}();\n' >"$BUNDLE/main-abc123.js"
"$HERE/bundle-scan.sh" "$WORK/bundle" "$WORK/bundle-clean.sarif" >"$WORK/bundle.log" 2>&1; rc=$?
[ "$rc" -eq 0 ] && check "clean built bundle passes" pass "bundle-scan exit 0" || check "clean built bundle passes" fail "bundle-scan exit $rc"
# The printed output and reports never contain the canary value.
if grep -rqF -e "$OPENAI_CANARY" -e "$WAVE_CANARY" "$WORK" --include='*.sarif' --include='*.log' --include='*.json'; then
  check "canary value is redacted in reports and logs" fail "value found"; else check "canary value is redacted in reports and logs" pass ""; fi

# ---- 4. The tree itself, through the real wrappers (these are the reports submit_check reads) -----------------
"$HERE/sast-custom.sh"; rc=$?
[ "$rc" -eq 0 ] && check "SAST of the tree with the custom rules is clean" pass "exit 0" || check "SAST of the tree with the custom rules is clean" fail "exit $rc"
"$HERE/secrets-custom.sh"; rc=$?
[ "$rc" -eq 0 ] && check "secret scan of the ticket range with the custom patterns is clean" pass "exit 0" || check "secret scan of the ticket range with the custom patterns is clean" fail "exit $rc"
CI_SECRETS_FULL=1 CI_REPORTS_DIR="$WORK/full" "$HERE/secrets-custom.sh" >"$WORK/full.log" 2>&1; rc=$?
[ "$rc" -eq 0 ] && check "full-history secret scan is clean" pass "exit 0" || { check "full-history secret scan is clean" fail "exit $rc"; tail -5 "$WORK/full.log"; }
if [ -d "$ROOT/apps/web/.next" ]; then
  "$HERE/bundle-scan.sh" >"$WORK/real-bundle.log" 2>&1; rc=$?
  [ "$rc" -eq 0 ] && check "built web bundle scan is clean" pass "" || check "built web bundle scan is clean" fail "exit $rc"
else echo "NOTE  no built web bundle at apps/web/.next; the bundle scan of the real build runs after pnpm build (DO-ci)"; fi

# ---- 5. Push protection read-back ---------------------------------------------------------------------------------
"$HERE/push-protection-readback.sh" "$ROOT/reports/security/push-protection.md" || true

# ---- junit ---------------------------------------------------------------------------------------------------------------
mkdir -p "$ROOT/reports/security"
python3 -I - "$RESULTS" "$ROOT/reports/security/junit.xml" <<'PY'
import sys
from xml.sax.saxutils import escape, quoteattr
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1])]
fails = [r for r in rows if r[1] != "pass"]
with open(sys.argv[2], "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n')
    f.write('<testsuite name="security-scan-config" tests="%d" failures="%d" errors="0" skipped="0">\n' % (len(rows), len(fails)))
    for name, status, detail in rows:
        f.write('<testcase classname="TASK-115" name=%s>' % quoteattr(name))
        if status != "pass":
            f.write('<failure message=%s/>' % quoteattr(detail or "failed"))
        f.write('</testcase>\n')
    f.write('</testsuite>\n</testsuites>\n')
PY
echo "== $(wc -l <"$RESULTS") checks, $FAILED failed"
[ "$FAILED" -eq 0 ]
