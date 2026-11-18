#!/usr/bin/env bash
# Workflow validation (DEVOPS-PLAN 3.2, 4.2, 4.6): actionlint, then the pinned-action and permission check.
# Fails an action that is not pinned by a 40-character commit, a third-party action outside the allow-list,
# a permission wider than the allow-list, a trigger that is not literally `main`, a removed required job, a job
# dropped from the gate's needs, a skipped or tolerated step and a weakened wrapper. The YAML is parsed (pinned yq
# to JSON), never matched line by line, so flow mappings and first-key list items are seen.
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
  tar -xzf "$tmp/$file" -C "$tmp" actionlint
  install -m 0755 "$tmp/actionlint" "$CI_TOOLS_DIR/bin/actionlint.tmp.$$" && mv -f "$CI_TOOLS_DIR/bin/actionlint.tmp.$$" "$CI_TOOLS_DIR/bin/actionlint"
  rm -rf "$tmp"
}

YQ_VERSION=4.54.3
YQ_SHA256=09a25baa0e136b8633949e03117fc82cb9e50d10910f988ef17a1305539ebce4  # yq_linux_amd64.tar.gz, from the release checksums-bsd
install_yq() {
  [ -x "$CI_TOOLS_DIR/bin/yq-$YQ_VERSION" ] && return 0
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$tmp/yq.tgz" "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64.tar.gz"
  echo "$YQ_SHA256  $tmp/yq.tgz" | sha256sum --check --status || { echo "checksum mismatch for yq" >&2; return 1; }
  mkdir -p "$CI_TOOLS_DIR/bin"
  tar -xzf "$tmp/yq.tgz" -C "$tmp" ./yq_linux_amd64
  install -m 0755 "$tmp/yq_linux_amd64" "$CI_TOOLS_DIR/bin/yq-$YQ_VERSION.tmp.$$" \
    && mv -f "$CI_TOOLS_DIR/bin/yq-$YQ_VERSION.tmp.$$" "$CI_TOOLS_DIR/bin/yq-$YQ_VERSION"
  rm -rf "$tmp"
}

files=("$@")
if [ ${#files[@]} -eq 0 ]; then
  shopt -s nullglob
  files=(.github/workflows/*.yml .github/workflows/*.yaml)
fi
[ ${#files[@]} -gt 0 ] || { echo "validate.sh: no workflow files found" >&2; exit 1; }

install_actionlint
install_yq
export YQ_BIN="$CI_TOOLS_DIR/bin/yq-$YQ_VERSION"
actionlint -version | head -1
actionlint "${files[@]}"
echo "actionlint: ${#files[@]} file(s) clean"

python3 -I - "$POLICY" "${files[@]}" <<'PY'
import json, os, re, subprocess, sys

policy = json.load(open(sys.argv[1]))["workflow"]
# DEVOPS-PLAN 4.6: the whole allow-list. Any addition is reviewed by the DevOps Reviewer and edited here.
ALLOWED_ACTIONS = {
    "actions/checkout", "actions/setup-node", "actions/upload-artifact", "actions/download-artifact",
    "actions/cache", "docker/setup-buildx-action", "docker/build-push-action", "docker/login-action",
}
ALLOWED_PERMISSIONS = set(policy["allowedPermissions"])
FORBIDDEN_TRIGGERS = set(policy["forbiddenTriggers"]) | {"workflow_run", "pull_request_target"}
# Wrapper each job of the real ci.yml must run; the gate job must run exactly GATE_RUN.
JOB_WRAPPERS = {
    "validate": ["lint", "types", "layers", "contract", "validate"],
    "unit": ["unit"], "integration": ["integration"], "security": ["sast", "deps", "secrets", "iac"],
    "build": ["build"], "container-scan": ["container"], "e2e": ["e2e"],
}
GATE_RUN = "scripts/ci/quality-gate.sh --profile release"
problems = []

def bad(path, where, text):
    problems.append("%s: %s: %s" % (path, where, text))

def is_always(value):
    return isinstance(value, str) and re.sub(r"[\s${}]", "", value) == "always()"

def check_permissions(path, where, value, strict):
    if value is None or isinstance(value, str):
        bad(path, where, "permissions must be a mapping listed per scope, not %r" % value)
        return
    if not isinstance(value, dict):
        bad(path, where, "permissions must be a mapping")
        return
    if strict is not None and value != strict:
        bad(path, where, "permissions must be exactly %s, found %s" % (json.dumps(strict), json.dumps(value)))
    for scope, level in value.items():
        if level not in ("read", "none") and "%s: %s" % (scope, level) not in ALLOWED_PERMISSIONS:
            bad(path, where, "permission %s: %s is wider than the allow-list" % (scope, level))

def check_uses(path, where, ref):
    name, _, pin = str(ref).partition("@")
    if name.startswith("./"):
        return
    if not re.fullmatch(r"[0-9a-f]{40}", pin):
        bad(path, where, "action %s is not pinned by a full commit SHA" % ref)
    if name not in ALLOWED_ACTIONS:
        bad(path, where, "action %s is not on the allow-list (DEVOPS-PLAN 4.6)" % name)

def strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from strings(k)
            yield from strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from strings(v)

def run_lines(step):
    return [l.strip() for l in str(step.get("run", "")).splitlines() if l.strip() and not l.strip().startswith("#")]

for path in sys.argv[2:]:
    raw = subprocess.run([os.environ["YQ_BIN"], "-o=json", "-I0", ".", path], capture_output=True, text=True)
    if raw.returncode != 0 or not raw.stdout.strip().startswith("{"):
        bad(path, "yaml", "cannot be parsed: " + raw.stderr.strip())
        continue
    doc = json.loads(raw.stdout)
    triggers = doc.get("on", doc.get(True))
    if isinstance(triggers, str):
        triggers = {triggers: {}}
    elif isinstance(triggers, list):
        triggers = {t: {} for t in triggers}
    if not isinstance(triggers, dict):
        bad(path, "on", "triggers are missing")
        triggers = {}
    for name in triggers:
        if name in FORBIDDEN_TRIGGERS:
            bad(path, "on", "trigger %s is forbidden" % name)
    is_release = doc.get("name") == "release"
    if is_release and set(triggers) != {"workflow_dispatch"}:
        bad(path, "on", "the release workflow runs on workflow_dispatch only, found %s" % sorted(triggers))
    for event in () if is_release else ("pull_request", "push"):
        cfg = triggers.get(event)
        if not isinstance(cfg, dict) or cfg.get("branches") != ["main"]:
            bad(path, "on." + event, "trigger %s must be limited to `branches: [main]`" % event)
        elif set(cfg) != {"branches"}:
            bad(path, "on." + event, "only `branches: [main]` is allowed (no tags, paths or types filters)")
    if "workflow_dispatch" not in triggers:
        bad(path, "on", "workflow_dispatch trigger is missing")
    for text in strings(triggers):
        if re.search(r"default_branch|default-branch", text):
            bad(path, "on", "triggers name `main` literally, not the default-branch variable")
    conc = doc.get("concurrency")
    if is_release:
        if not isinstance(conc, dict) or conc.get("cancel-in-progress") is not False or "release-" not in str(conc.get("group")):
            bad(path, "concurrency", "the release workflow needs a release-<environment> group with cancel-in-progress: false")
    elif not isinstance(conc, dict) or conc.get("cancel-in-progress") is not True:
        bad(path, "concurrency", "concurrency with cancel-in-progress: true is required")
    is_ci = doc.get("name") == "ci"
    if "permissions" not in doc:
        bad(path, "permissions", "a top-level permissions block is required (default permissions: {})")
    else:
        check_permissions(path, "permissions", doc["permissions"], {} if is_ci else None)
    jobs = doc.get("jobs") or {}
    for job_id, job in jobs.items():
        where = "jobs." + job_id
        if "permissions" not in job:
            bad(path, where, "a job permissions block is required")
        else:
            check_permissions(path, where + ".permissions", job["permissions"], {"contents": "read"} if is_ci else None)
        if "continue-on-error" in job:
            bad(path, where, "continue-on-error is not allowed (every job blocks)")
        if "if" in job and not is_always(job["if"]):
            bad(path, where, "a job `if:` could skip a required check (only `if: always()` is allowed)")
        if "uses" in job:
            check_uses(path, where, job["uses"])
        for index, step in enumerate(job.get("steps") or []):
            at = "%s.steps[%d]" % (where, index)
            if "continue-on-error" in step:
                bad(path, at, "continue-on-error is not allowed (every job blocks)")
            if "if" in step and not is_always(step["if"]):
                bad(path, at, "a step `if:` could skip a required check (only `if: always()` is allowed)")
            if "uses" in step:
                check_uses(path, at, step["uses"])
            for line in run_lines(step):
                if re.search(r"\|\|\s*(true|:|exit\s+0)\b|;\s*(true|:)\s*$|^set \+e\b|^true$", line):
                    bad(path, at, "run line tolerates failure: %s" % line)
    if not is_ci:
        continue
    required = policy["requiredJobs"]
    missing = [j for j in required if j not in jobs]
    if missing:
        bad(path, "jobs", "required job(s) missing: " + ", ".join(missing))
    gate = jobs.get("quality-gate", {})
    need = gate.get("needs")
    need = [need] if isinstance(need, str) else (need or [])
    expected = sorted(j for j in required if j != "quality-gate")
    if sorted(need) != expected:
        bad(path, "jobs.quality-gate.needs", "must list exactly %s, found %s" % (expected, sorted(need)))
    gate_runs = [l for s in gate.get("steps") or [] for l in run_lines(s) if "quality-gate.sh" in l]
    if gate_runs != [GATE_RUN]:
        bad(path, "jobs.quality-gate", "must run exactly `%s` once, found %s" % (GATE_RUN, gate_runs))
    gate_uses = [str(s.get("uses", "")).split("@")[0] for s in gate.get("steps") or []]
    if "actions/download-artifact" not in gate_uses:
        bad(path, "jobs.quality-gate", "must download every job's report artifact")
    for job_id, wrappers in JOB_WRAPPERS.items():
        steps = (jobs.get(job_id) or {}).get("steps") or []
        lines = [l for s in steps for l in run_lines(s)]
        for w in wrappers:
            pattern = r"^(?:[A-Z_]+=\S+ )?scripts/ci/%s\.sh(?: \|\| rc=1)?$" % re.escape(w)
            if not any(re.match(pattern, l) for l in lines):
                bad(path, "jobs." + job_id, "must run scripts/ci/%s.sh as its own command line" % w)
            if any(re.match(pattern, l) and l.endswith("|| rc=1") for l in lines) and 'exit "$rc"' not in lines:
                bad(path, "jobs." + job_id, 'wrappers collected with `|| rc=1` need a final `exit "$rc"`')
        uploads = [s for s in steps if str(s.get("uses", "")).startswith("actions/upload-artifact@")]
        if not any((s.get("with") or {}).get("name") == "reports-" + job_id and is_always(s.get("if")) for s in uploads):
            bad(path, "jobs." + job_id, "must upload reports-%s with `if: always()`" % job_id)

if problems:
    print("validate.sh: %d problem(s)" % len(problems), file=sys.stderr)
    for item in problems:
        print("  " + item, file=sys.stderr)
    sys.exit(1)
print("validate.sh: workflow policy clean (%d file(s))" % (len(sys.argv) - 2))
PY
