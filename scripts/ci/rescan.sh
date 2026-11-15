#!/usr/bin/env bash
# Milestone rescan (DEVOPS-PLAN DO-09). Runs as a Paperclip server task, never as a hosted schedule:
# dependency (osv-scanner + pnpm audit), SAST, secrets, container and IaC scans through the same wrappers the
# pipeline uses, writes every report, and fails on a Critical or High finding or a tool failure.
#   rescan.sh            full rescan: secrets over the whole git history
#   rescan.sh --dry-run  same scans, secrets over the ticket range (origin/dev..HEAD); used as a ticket check
# Writes reports/ci/rescan-junit.xml (one case per scan), reports/deps.json (merged dependency findings) and
# reports/rescan/summary.json. Every scan runs even when an earlier one fails.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode=full
for arg in "$@"; do
  case "$arg" in
    --dry-run) mode=dry-run ;;
    -h|--help) sed -n 2,8p "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "rescan.sh: unknown option '$arg'" >&2; exit 2 ;;
  esac
done
[ "$mode" = full ] && export CI_SECRETS_FULL=1
export CI=1
mkdir -p "$REPORTS/ci" "$REPORTS/rescan"

scans=(deps sast secrets container iac)
rcs=()
for s in "${scans[@]}"; do
  echo "== rescan: $s ($mode) =="
  rc=0
  bash "$CI_DIR/$s.sh" || rc=$?
  rcs+=("$rc")
done

python3 -I - "$REPORTS" "$mode" "$SOURCE_SHA" "${scans[*]}" "${rcs[*]}" <<'PY'
import json, os, sys
from xml.sax.saxutils import quoteattr

reports, mode, sha = sys.argv[1:4]
scans, rcs = sys.argv[4].split(), [int(x) for x in sys.argv[5].split()]
ids = {"deps": ["deps", "deps-audit"], "sast": ["sast"], "secrets": ["secrets"],
       "container": ["container"], "iac": ["iac"]}
rows, cases, merged = [], [], []
for scan, rc in zip(scans, rcs):
    status, counts = "pass" if rc == 0 else "fail", {"blocking": 0, "recorded": 0, "dismissed": 0}
    notes = []
    for rid in ids[scan]:
        meta = os.path.join(reports, "meta", rid + ".json")
        if os.path.isfile(meta):
            m = json.load(open(meta))
            if m["status"] == "not_applicable":
                notes.append("%s: not applicable: %s" % (rid, m.get("reason")))
        fp = os.path.join(reports, "findings", rid + ".json")
        if os.path.isfile(fp):
            f = json.load(open(fp))
            counts["blocking"] += len(f["blocking"]); counts["recorded"] += len(f["nonBlocking"])
            counts["dismissed"] += len(f["dismissed"])
            if scan == "deps":
                merged += f["blocking"] + f["nonBlocking"]
    if rc == 0 and notes:
        status = "not_applicable"
    rows.append({"scan": scan, "exitCode": rc, "status": status, **counts, "notes": notes})
    body = ""
    if status == "fail":
        body = "<failure message=%s/>" % quoteattr("exit %d, %d blocking" % (rc, counts["blocking"]))
    elif status == "not_applicable":
        body = "<skipped message=%s/>" % quoteattr("; ".join(notes))
    cases.append('<testcase classname="rescan" name=%s>%s</testcase>' % (quoteattr(scan), body))
failed = sum(r["status"] == "fail" for r in rows)
skipped = sum(r["status"] == "not_applicable" for r in rows)
os.makedirs(os.path.join(reports, "ci"), exist_ok=True)
with open(os.path.join(reports, "ci", "rescan-junit.xml"), "w") as h:
    h.write('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="rescan" tests="%d" failures="%d" '
            'skipped="%d" errors="0">\n%s\n</testsuite></testsuites>\n' % (len(rows), failed, skipped, "\n".join(cases)))
json.dump({"findings": merged}, open(os.path.join(reports, "deps.json"), "w"), indent=2)
json.dump({"mode": mode, "sourceSha": sha, "ok": failed == 0, "scans": rows},
          open(os.path.join(reports, "rescan", "summary.json"), "w"), indent=2)
for r in rows:
    print("rescan %-9s %-14s blocking=%d recorded=%d %s" % (r["scan"], r["status"], r["blocking"], r["recorded"], "; ".join(r["notes"])))
print("RESCAN %s (%s)" % ("PASS" if failed == 0 else "FAIL", mode))
sys.exit(1 if failed else 0)
PY
