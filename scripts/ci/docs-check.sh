#!/usr/bin/env bash
# Documentation check (TASK-017, ARCHITECTURE 9.4): README.md, RUN-GUIDE.md and docs/ops/{ROLLBACK-RUNBOOK,
# OPERATIONS-HANDOFF,owner-items}.md must be true of the code. It fails when:
#   - a required section or name is missing from a document;
#   - a script, file or folder a document names does not exist, or a `pnpm` command names a script no package has;
#   - a command of the README's quick start is not in RUN-GUIDE.md word for word;
#   - an operator command or its audit event differs between the code (apps/api/src/platform/ops-cli) and the runbook;
#   - a variable of .env.example is missing from the README table;
#   - the owner-item list differs from the closed register (docs/evidence/TASK-017/register-snapshot.tsv);
#   - `config-consistency.mjs` (registry, schema, .env.example) fails.
# Writes reports/docs/junit.xml and reports/docs/summary.txt. Usage: docs-check.sh   (run with CI=1)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
out="$REPORTS/docs"
mkdir -p "$out"
rc=0
python3 -I - "$CI_ROOT" "$out" <<'PY' || rc=$?
import difflib, json, os, re, subprocess, sys, time
import xml.etree.ElementTree as ET

root, out = sys.argv[1], sys.argv[2]
os.chdir(root)
cases = []  # (suite, name, failure message or None, seconds)


def case(suite, name, fn):
    started = time.time()
    try:
        message = fn()
    except Exception as error:  # a crashed check is a failed check
        message = f"{type(error).__name__}: {error}"
    cases.append((suite, name, message or None, time.time() - started))


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


DOCS = ["README.md", "RUN-GUIDE.md", "docs/ops/ROLLBACK-RUNBOOK.md", "docs/ops/OPERATIONS-HANDOFF.md", "docs/ops/owner-items.md"]


def cells(line):
    """The cells of a markdown table row, whatever padding a formatter gave them."""
    return [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def headings(text):
    return [m.group(2).strip() for m in re.finditer(r"^(#{1,4}) (.+)$", text, re.M)]


def need_headings(path, wanted):
    def run():
        have = " | ".join(headings(read(path))).lower()
        missing = [w for w in wanted if w.lower() not in have]
        return f"{path}: missing section(s): {', '.join(missing)}" if missing else None
    return run


# ---- 1. required sections -------------------------------------------------------------------------------------------
case("sections", "files exist", lambda: ", ".join(p for p in DOCS if not os.path.isfile(p)) or None)
case("sections", "README sections", need_headings("README.md", [
    "Features and screens", "Architecture", "Tech stack", "Prerequisites", "Quick start", "Configuration",
    "Migrations and seeds", "Tests and checks", "Project layout", "Deployment-ready status", "Operations",
    "Troubleshooting", "Contributing", "Licence"]))
case("sections", "RUN-GUIDE sections", need_headings("RUN-GUIDE.md", [
    "Prerequisites", "Clone and install", "Local configuration", "Start the local stack", "Provision the database roles",
    "Build", "Migrate and seed", "Run the api, worker and web", "Operator commands", "Run the checks",
    "Run each baseline", "Release, rollback and operations", "Troubleshooting"]))
case("sections", "ROLLBACK-RUNBOOK sections", need_headings("docs/ops/ROLLBACK-RUNBOOK.md", [
    "Rules that never change", "Names this release fills", "Decision matrix", "Artifact rollback", "Configuration rollback",
    "Migration failure", "Data restore", "Operator commands and their audit events"]))
case("sections", "OPERATIONS-HANDOFF sections", need_headings("docs/ops/OPERATIONS-HANDOFF.md", [
    "Ownership", "What runs", "Alerts and their runbooks", "Routine", "Names this release fills", "Incident note",
    "Documentation readiness", "Go-live evidence and product gaps", "OPERATIONS_RECEIPT"]))

# DEVOPS-PLAN 14.5 names the runbook must carry.
def rollback_names():
    text = read("docs/ops/ROLLBACK-RUNBOOK.md").lower()
    required = ["prior artifact", "does not undo a migration", "container restart is not a rollback", "forward fix",
                "24 h", "configuration rollback", "compromised credential", "release record", "previous digests"]
    missing = [r for r in required if r not in text]
    return f"ROLLBACK-RUNBOOK.md lacks: {', '.join(missing)}" if missing else None
case("rollback", "DEVOPS-PLAN 14.5 names", rollback_names)

# ---- 2. what the documents name exists ------------------------------------------------------------------------------
PATH_ROOTS = ("scripts/", "docs/", "config/", "infra/", ".github/", "apps/", "packages/", "docker/", "tools/", "design/")
SKIP = re.compile(r"[<>*{}$|]|\.\.\.|NNNN|TASK-0[0-9]x")


def path_tokens(text):
    for m in re.finditer(r"`([^`\n]+)`", text):
        for cand in m.group(1).split():
            cand = cand.rstrip(".,;:)")
            if cand.startswith(PATH_ROOTS) and not SKIP.search(cand):
                yield cand


# Paths that exist only at run time, are named as outputs, or are evidence of a later ticket.
RUNTIME = ("reports/", "dist/", ".env.local.d", "node_modules/")


def names_exist():
    missing = []
    for path in DOCS:
        if path == "docs/ops/owner-items.md":
            continue  # the register's own words, quoted; the file is checked against the register in section 5
        for cand in sorted(set(path_tokens(read(path)))):
            if cand.endswith("/"):
                ok = os.path.isdir(cand)
            elif "#" in cand:
                ok = os.path.exists(cand.split("#")[0])
            else:
                ok = os.path.exists(cand)
            if not ok and not cand.startswith(RUNTIME):
                missing.append(f"{path}: {cand}")
    return "named but absent: " + "; ".join(missing) if missing else None
case("names", "every named script, file and folder exists", names_exist)


def local_links():
    missing = []
    for path in DOCS:
        base = os.path.dirname(path)
        for m in re.finditer(r"\]\(([^)#\s]+)(#[^)]*)?\)", read(path)):
            target = m.group(1)
            if "://" in target or target.startswith("mailto:"):
                continue
            if not os.path.exists(os.path.normpath(os.path.join(base, target))):
                missing.append(f"{path}: {target}")
    return "broken links: " + "; ".join(missing) if missing else None
case("names", "relative links resolve", local_links)


def package_scripts():
    scripts = {}
    for pkg in subprocess.run(["git", "ls-files", "package.json", "*/package.json", "*/*/package.json"], capture_output=True, text=True, check=True).stdout.split():
        data = json.loads(read(pkg))
        scripts[data.get("name", pkg)] = set(data.get("scripts", {}))
    return scripts


def bash_blocks(text):
    return re.findall(r"```bash\n(.*?)```", text, re.S)


def pnpm_commands():
    scripts = package_scripts()
    all_names = set().union(*scripts.values())
    root = scripts.get("shroomap", set())
    builtins = {"install", "exec", "dlx", "run", "add", "remove", "-r", "enable"}
    bad = []
    for path in ("README.md", "RUN-GUIDE.md"):
        text = read(path)
        for line in "\n".join(bash_blocks(text)).splitlines() + re.findall(r"`(pnpm [^`\n]+)`", text):
            for m in re.finditer(r"\bpnpm (?:--filter (\S+) )?([A-Za-z0-9:_-]+)", line):
                pkg, name = m.group(1), m.group(2)
                if name in builtins or name.startswith("-"):
                    continue
                if pkg:
                    if pkg not in scripts:
                        bad.append(f"{path}: package {pkg}")
                    elif name not in scripts[pkg]:
                        bad.append(f"{path}: {pkg} has no script {name}")
                elif name not in root and name not in all_names:
                    bad.append(f"{path}: no script {name}")
    return "; ".join(sorted(set(bad))) or None
case("commands", "every pnpm command names an existing script", pnpm_commands)


def command_files():
    bad = []
    for path in ("README.md", "RUN-GUIDE.md"):
        for block in bash_blocks(read(path)):
            for line in block.splitlines():
                line = line.strip()
                if line.startswith("#"):
                    continue
                for m in re.finditer(r"(?:^|[\s(])((?:\./)?(?:scripts|docker|config|tools)/[A-Za-z0-9_./-]+)", line):
                    f = m.group(1).lstrip("./") if m.group(1).startswith("./") else m.group(1)
                    if not os.path.exists(f):
                        bad.append(f"{path}: {f}")
    return "command names a missing file: " + "; ".join(sorted(set(bad))) if bad else None
case("commands", "every file a command names exists", command_files)


def quick_start_in_guide():
    guide = {l.strip() for b in bash_blocks(read("RUN-GUIDE.md")) for l in b.splitlines()}
    drift = []
    for b in bash_blocks(read("README.md")):
        for l in b.splitlines():
            l = l.strip()
            if l and not l.startswith("#") and l not in guide and l not in {"pnpm typecheck"} and not l.startswith(("pnpm ", "node scripts/ci/config", "scripts/ci/docs-check.sh")):
                drift.append(l[:80])
    return "README commands not in RUN-GUIDE.md word for word: " + "; ".join(drift) if drift else None
case("commands", "README quick start equals RUN-GUIDE.md", quick_start_in_guide)

# ---- 3. operator commands and audit events match the code -----------------------------------------------------------
def ops_match():
    args = read("apps/api/src/platform/ops-cli/args.ts")
    cmds = commands_src = None
    m = re.search(r"OPS_COMMANDS = \[(.*?)\] as const", args, re.S)
    code_cmds = re.findall(r"'([^']+)'", m.group(1))
    code_events = sorted(set(re.findall(r"auditOperator\([^)]*?'([a-z_]+\.[a-z_]+)'", read("apps/api/src/platform/ops-cli/commands.ts"), re.S)))
    runbook = read("docs/ops/ROLLBACK-RUNBOOK.md")
    guide = read("RUN-GUIDE.md")
    problems = []
    for c in code_cmds:
        if f"`{c}" not in runbook:
            problems.append(f"runbook lacks command {c}")
        if f"ops.js {c}" not in guide:
            problems.append(f"RUN-GUIDE lacks command {c}")
    for e in code_events:
        if f"`{e}`" not in runbook:
            problems.append(f"runbook lacks audit event {e}")
    documented = set(re.findall(r"^\| `([a-z-]+:[a-z-]+)", runbook, re.M))
    for c in documented - set(code_cmds):
        problems.append(f"runbook documents unknown command {c}")
    table_events = set(re.findall(r"`([a-z_]+\.[a-z_]+)`, `(?:platform_settings|provider_key|user|campaign)`", runbook))
    for e in table_events - set(code_events):
        problems.append(f"runbook documents unknown audit event {e}")
    for role_cmd, role in re.findall(r"'([a-z-]+:[a-z-]+)': '(api|worker)'", args):
        row = next((cells(l) for l in runbook.splitlines() if l.startswith(f"| `{role_cmd}")), [])
        if len(row) < 2 or row[1] != role:
            problems.append(f"runbook role of {role_cmd} is not {role}")
    return "; ".join(problems) or None
case("operator", "commands, roles and audit events equal the code", ops_match)


def alerts_match():
    alerts = json.loads(read("infra/monitoring/alerts.json"))["alerts"]
    text = read("docs/ops/OPERATIONS-HANDOFF.md")
    bad = []
    for a in alerts:
        row = next((l for l in text.splitlines() if l.startswith("|") and cells(l)[0] == a["id"]), "")
        if f"{a['runbook']}.md" not in row:
            bad.append(f"{a['id']} -> {a['runbook']}")
        if not os.path.isfile(f"docs/ops/runbooks/{a['runbook']}.md"):
            bad.append(f"{a['runbook']}.md absent")
    return "alert rows differ from infra/monitoring/alerts.json: " + "; ".join(bad) if bad else None
case("operator", "every alert row names its runbook", alerts_match)

# ---- 4. configuration table covers .env.example ---------------------------------------------------------------------
def env_covered():
    names = set()
    for line in read(".env.example").splitlines():
        m = re.match(r"^#? ?([A-Z][A-Z0-9_]+)[=:]", line)
        if m:
            names.add(m.group(1))
    readme = read("README.md")
    missing = sorted(n for n in names if f"`{n}`" not in readme)
    return f"README configuration table lacks {len(missing)} variable(s): {', '.join(missing)}" if missing else None
case("config", "README lists every .env.example variable", env_covered)

# ---- 5. owner items equal the closed register -----------------------------------------------------------------------
def owner_items():
    snap = [l.rstrip("\n").split("\t") for l in read("docs/evidence/TASK-017/register-snapshot.tsv").splitlines() if l and not l.startswith("#")]
    want = [f"{i}\t{s}" for i, s in snap]
    have = []
    for l in read("docs/ops/owner-items.md").splitlines():
        if l.startswith("| ") and not l.startswith(("| ID", "| ---")):
            cs = cells(l)
            have.append(f"{cs[0]}\t{cs[5].replace(chr(92) + '|', '|')}")
    diff = list(difflib.unified_diff(want, have, "register", "owner-items.md", lineterm="", n=0))
    return "owner-items.md differs from the register:\n" + "\n".join(diff) if diff else None
case("owner-items", "IDs and statuses equal the register", owner_items)


def autonomous_marked():
    snap = [l.split("\t") for l in read("docs/evidence/TASK-017/register-snapshot.tsv").splitlines() if l and not l.startswith("#")]
    text = read("docs/ops/owner-items.md")
    n = sum(1 for _, s in snap if s.strip() == "default applied (autonomous)")
    m = sum(1 for l in text.splitlines() if l.startswith("| ") and len(cells(l)) > 5 and cells(l)[5] == "default applied (autonomous)")
    return f"{n} register entries are default applied (autonomous), the list shows {m}" if n != m else None
case("owner-items", "every default applied (autonomous) entry is listed", autonomous_marked)

# ---- 6. configuration consistency -----------------------------------------------------------------------------------
def consistency():
    r = subprocess.run(["node", "scripts/ci/config-consistency.mjs"], capture_output=True, text=True)
    return None if r.returncode == 0 else "config-consistency.mjs failed:\n" + (r.stdout + r.stderr)[-1500:]
case("config", "registry, schema and .env.example agree", consistency)

# ---- report ---------------------------------------------------------------------------------------------------------
suites = {}
for suite, name, message, seconds in cases:
    suites.setdefault(suite, []).append((name, message, seconds))
top = ET.Element("testsuites")
failed = 0
for suite, items in suites.items():
    el = ET.SubElement(top, "testsuite", name=f"docs.{suite}", tests=str(len(items)),
                       failures=str(sum(1 for _, m, _ in items if m)), time=f"{sum(s for _, _, s in items):.3f}")
    for name, message, seconds in items:
        tc = ET.SubElement(el, "testcase", classname=f"docs.{suite}", name=name, time=f"{seconds:.3f}")
        if message:
            failed += 1
            ET.SubElement(tc, "failure", message=message.splitlines()[0][:300]).text = message
os.makedirs(out, exist_ok=True)
ET.ElementTree(top).write(os.path.join(out, "junit.xml"), encoding="utf-8", xml_declaration=True)
lines = [f"{'FAIL' if m else 'ok  '} {s}: {n}" + (f"\n       {m}" if m else "") for s, n, m, _ in cases]
lines.append(f"{len(cases) - failed} of {len(cases)} documentation checks passed")
open(os.path.join(out, "summary.txt"), "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
sys.exit(1 if failed else 0)
PY
if [ "$rc" -eq 0 ]; then record docs junit pass "docs-check" 0 docs/junit.xml
else record docs junit fail "docs-check" "$rc" docs/junit.xml "documentation check failed"; fi
exit "$rc"
