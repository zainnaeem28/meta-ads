#!/usr/bin/env bash
# Workflow validation (DEVOPS-PLAN 3.2, 4.2, 4.6): actionlint, then the pinned-action and permission check.
# Fails an action that is not pinned by a 40-character commit, a third-party action outside the allow-list,
# a permission wider than the allow-list, a trigger that is not literally `main`, and a removed required job.
# Usage: validate.sh [workflow-file ...]   (default: every file in .github/workflows)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ACTIONLINT_VERSION=1.7.12

install_actionlint() {
  command -v actionlint >/dev/null 2>&1 && return 0
  local tmp file base; tmp="$(mktemp -d)"
  file="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
  base="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}"
  curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file"
  curl -fsSL --retry 3 -o "$tmp/sums" "$base/actionlint_${ACTIONLINT_VERSION}_checksums.txt"
  echo "$(awk -v f="$file" '$2==f {print $1}' "$tmp/sums")  $tmp/$file" | sha256sum --check --status \
    || { echo "checksum mismatch for $file" >&2; return 1; }
  mkdir -p "$CI_TOOLS_DIR/bin"
  tar -xzf "$tmp/$file" -C "$CI_TOOLS_DIR/bin" actionlint
  rm -rf "$tmp"
}

files=("$@")
if [ ${#files[@]} -eq 0 ]; then
  shopt -s nullglob
  files=(.github/workflows/*.yml .github/workflows/*.yaml)
fi
[ ${#files[@]} -gt 0 ] || { echo "validate.sh: no workflow files found" >&2; exit 1; }

install_actionlint
actionlint -version | head -1
actionlint "${files[@]}"
echo "actionlint: ${#files[@]} file(s) clean"

python3 -I - "$POLICY" "${files[@]}" <<'PY'
import json, re, sys

policy = json.load(open(sys.argv[1]))["workflow"]
# DEVOPS-PLAN 4.6: the whole allow-list. Any addition is reviewed by the DevOps Reviewer and edited here.
ALLOWED_ACTIONS = {
    "actions/checkout", "actions/setup-node", "actions/upload-artifact", "actions/download-artifact",
    "actions/cache", "docker/setup-buildx-action", "docker/build-push-action", "docker/login-action",
}
ALLOWED_PERMISSIONS = set(policy["allowedPermissions"])
problems = []

def bad(path, number, text):
    problems.append("%s:%d: %s" % (path, number, text))

for path in sys.argv[2:]:
    lines = open(path, encoding="utf-8").read().splitlines()
    in_perm, perm_indent, in_on, wf_name = False, 0, False, None
    for number, raw in enumerate(lines, 1):
        line = raw.split(" #")[0].rstrip() if not raw.lstrip().startswith("#") else ""
        uses = re.match(r"^\s*-?\s*uses:\s*(\S+)", line)
        if uses:
            ref = uses.group(1)
            name, _, pin = ref.partition("@")
            if name.startswith("./"):
                continue
            if not re.fullmatch(r"[0-9a-f]{40}", pin):
                bad(path, number, "action %s is not pinned by a full commit SHA" % ref)
            if name not in ALLOWED_ACTIONS:
                bad(path, number, "action %s is not on the allow-list (DEVOPS-PLAN 4.6)" % name)
        if re.match(r"^\s*permissions:\s*(read-all|write-all)\b", line):
            bad(path, number, "permissions must be listed per scope, not read-all or write-all")
        if re.match(r"^\s*permissions:\s*$", line):
            in_perm, perm_indent = True, len(line) - len(line.lstrip())
            continue
        if in_perm:
            if not line.strip():
                continue
            indent = len(line) - len(line.lstrip())
            item = re.match(r"^\s+([a-z-]+):\s*(\S+)", line)
            if indent <= perm_indent or not item:
                in_perm = False
            else:
                scope, level = item.group(1), item.group(2)
                if level not in ("read", "none") and "%s: %s" % (scope, level) not in ALLOWED_PERMISSIONS:
                    bad(path, number, "permission %s: %s is wider than the allow-list" % (scope, level))
        if re.match(r"^\s*continue-on-error:", line):
            bad(path, number, "continue-on-error is not allowed (every job blocks)")
        for trigger in policy["forbiddenTriggers"] + ["workflow_run", "pull_request_target"]:
            if re.match(r"^\s*%s\s*:" % re.escape(trigger), line):
                bad(path, number, "trigger %s is forbidden" % trigger)
        if re.match(r"^\s*tags(-ignore)?\s*:", line):
            bad(path, number, "tag triggers are forbidden (main-only hosted CI)")
        if re.search(r"github\.event\.repository\.default_branch|\$default-branch", line):
            bad(path, number, "triggers and refs name `main` literally, not the default-branch variable")
        if re.match(r"^\s+if:", line) and not re.search(r"always\(\)", line):
            bad(path, number, "a job or step `if:` could skip a required check (only `if: always()` is allowed)")
    text = "\n".join(lines)
    for event in ("pull_request", "push"):
        block = re.search(r"^  %s:\s*\n((?:    .*\n?)+)" % event, text + "\n", re.M)
        if not block or not re.search(r"^    branches:\s*\[main\]\s*$", block.group(1), re.M):
            bad(path, 1, "trigger %s must be limited to `branches: [main]`" % event)
    if not re.search(r"^  workflow_dispatch:", text, re.M):
        bad(path, 1, "workflow_dispatch trigger is missing")
    if not re.search(r"^concurrency:", text, re.M) or "cancel-in-progress: true" not in text:
        bad(path, 1, "concurrency with cancel-in-progress: true is required")
    if not re.search(r"^permissions:", text, re.M):
        bad(path, 1, "a top-level permissions block is required (default permissions: {})")
    if re.search(r"^name:\s*ci\s*$", text, re.M):
        jobs = re.findall(r"^  ([A-Za-z0-9_-]+):\s*$", text.split("\njobs:", 1)[-1], re.M)
        missing = [j for j in policy["requiredJobs"] if j not in jobs]
        if missing:
            bad(path, 1, "required job(s) missing: " + ", ".join(missing))

if problems:
    print("validate.sh: %d problem(s)" % len(problems), file=sys.stderr)
    for item in problems:
        print("  " + item, file=sys.stderr)
    sys.exit(1)
print("validate.sh: workflow policy clean (%d file(s))" % (len(sys.argv) - 2))
PY
