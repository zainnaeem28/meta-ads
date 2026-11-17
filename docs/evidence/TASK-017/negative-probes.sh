#!/usr/bin/env bash
# Each probe damages one documentation fact in place, runs docs-check.sh and requires it to FAIL, then restores the file.
# Usage: CI=1 docs/evidence/TASK-017/negative-probes.sh   (output: docs/evidence/TASK-017/negative-probes.txt)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
BACKUP="$(mktemp -d)"
restore() { cp -r "$BACKUP"/. . ; rm -rf "$BACKUP"; }
trap restore EXIT
mkdir -p "$BACKUP/docs/ops"
cp README.md RUN-GUIDE.md "$BACKUP/"; cp docs/ops/ROLLBACK-RUNBOOK.md docs/ops/OPERATIONS-HANDOFF.md docs/ops/owner-items.md "$BACKUP/docs/ops/"
bad=0
probe() { # NAME FILE SED-EXPRESSION
  local name="$1" file="$2" expr="$3"
  sed -i -E "$expr" "$file"
  if CI=1 scripts/ci/docs-check.sh >/tmp/probe.out 2>&1; then echo "MISSED  $name"; bad=1; else echo "caught  $name  ($(grep -m1 '^FAIL' /tmp/probe.out | cut -c1-90))"; fi
  cp "$BACKUP/$file" "$file"
}
probe "owner item dropped from the list"           docs/ops/owner-items.md          '/^\| OI-CAPS /d'
probe "owner item restated (status changed)"       docs/ops/owner-items.md          's/^(\| OD-01 .*)default applied \(autonomous\)/\1decided/'
probe "audit event renamed in the runbook"         docs/ops/ROLLBACK-RUNBOOK.md     's/key\.disabled_all/key.disabled_everything/'
probe "operator command dropped from the runbook"  docs/ops/ROLLBACK-RUNBOOK.md     's/^\| `kek:rewrap`/| `kek:rewrapped-by-hand`/'
probe "variable missing from the README table"     README.md                        '/^\| `R2_LEDGER_BUCKET` /d'
probe "script that does not exist is named"        RUN-GUIDE.md                     's#scripts/ci/e2e\.sh#scripts/ci/e2e-gone.sh#'
probe "pnpm script that does not exist"            RUN-GUIDE.md                     's#db:migrate \)#db:migrate-all )#'
probe "README command drifts from the guide"       README.md                        's#pg_isready -U postgres -d shroomap_dev#pg_isready -U root -d shroomap_dev#'
probe "required README section removed"            README.md                        's/^## Troubleshooting/## Help/'
probe "alert row points at the wrong runbook"      docs/ops/OPERATIONS-HANDOFF.md   's#RB-startup\.md#RB-nothing.md#'
CI=1 scripts/ci/docs-check.sh >/tmp/probe.out 2>&1 && echo "restored files pass again: $(tail -1 /tmp/probe.out)" || { echo "restore failed"; bad=1; }
exit $bad
