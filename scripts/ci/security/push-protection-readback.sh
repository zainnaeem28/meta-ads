#!/usr/bin/env bash
# Read back the host's secret scanning and push protection settings (GitHub) and write them to FILE. Where the plan
# or the token does not allow the read, the result is a recorded gap (exit 0, status GAP), never a silent pass.
# Usage: push-protection-readback.sh FILE
set -uo pipefail
out="${1:?usage: push-protection-readback.sh FILE}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
mkdir -p "$(dirname "$out")"
url="$(git remote get-url origin 2>/dev/null || true)"
slug="$(printf '%s' "$url" | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')"
status=GAP; detail=""
if ! command -v gh >/dev/null 2>&1; then detail="the gh CLI is not available"
elif ! printf '%s' "$slug" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then detail="the origin remote is not a GitHub repository ($url)"
else
  json="$(gh api "repos/$slug" --jq '.security_and_analysis // empty' 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then detail="gh api exited $rc: $(printf '%s' "$json" | head -c 300)"
  elif [ -z "$json" ]; then detail="security_and_analysis is not returned to this token (needs admin or security-manager access on the repository)"
  else
    ss="$(printf '%s' "$json" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d.get('secret_scanning',{}).get('status','absent'), d.get('secret_scanning_push_protection',{}).get('status','absent'))")"
    detail="secret_scanning / secret_scanning_push_protection = $ss"
    case "$ss" in "enabled enabled") status=ENABLED ;; *) status=NOT_ENABLED ;; esac
  fi
fi
{
  echo "# Host push protection read-back"
  echo
  echo "- Repository: \`$slug\`"
  echo "- Read at: $(date -u +%Y-%m-%dT%H:%M:%SZ), commit $(git rev-parse --short HEAD)"
  echo "- Result: **$status**"
  echo "- Detail: $detail"
  if [ "$status" != ENABLED ]; then
    echo
    echo "Recorded gap: the host does not confirm push protection here. The gitleaks gate on the diff, the full history and the"
    echo "built bundle is the enforced control; enabling GitHub secret scanning and push protection is a repository-owner action"
    echo "(go-live owner item), to be re-read with this script after it is switched on."
  fi
} >"$out"
echo "push protection: $status ($detail)"
