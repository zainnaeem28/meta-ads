#!/usr/bin/env bash
# Database lint (ARCHITECTURE 2.3, 2.7). Fails on:
#   1. `drizzle-kit push` anywhere in scripts, package manifests, workflows, Dockerfiles or source.
#   2. A `provider_keys` read or write without a column projection: `.select()` / `.returning()` with no columns,
#      `db.query.providerKeys.find*` without `columns`, `getTableColumns(providerKeys)`, `select *` from the table.
#      A statement carrying a `lint-db-allow: <reason>` comment is skipped (negative probes of the grants).
#   3. A migration file under apps/api/src/database/migrations not named `<NNNN>_task-<NNN>-<slug>.sql` or sharing a number.
# LINT_ROOT points the check at another tree (the negative probes in apps/api use temporary trees).
set -euo pipefail
ROOT="${LINT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
exec python3 -I - "$ROOT" <<'PY'
import os, re, sys

root = sys.argv[1]
SKIP_DIRS = {"node_modules", ".git", "dist", ".next", "reports", "evidence", "probes", ".cache", "fixtures"}
SKIP_FILES = {"lint-db.sh", "lint-db.test.ts"}
TEXT = (".sh", ".json", ".yml", ".yaml", ".ts", ".mts", ".cjs", ".mjs", ".js", ".toml", ".py")
problems = []

def files():
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            if name in SKIP_FILES or not (name.endswith(TEXT) or name.startswith("Dockerfile")):
                continue
            yield os.path.join(base, name)

PUSH = re.compile(r"drizzle-kit\s+push\b")
PK = r"(?:providerKeys|provider_keys|ProviderKeys|providerKeysTable)"
STATEMENT_SPLIT = re.compile(r";")
EMPTY_SELECT = re.compile(r"\.select\(\s*\)")
EMPTY_RETURNING = re.compile(r"\.returning\(\s*\)")

def rel(path):
    return os.path.relpath(path, root)

for path in files():
    try:
        text = open(path, encoding="utf-8").read()
    except (UnicodeDecodeError, OSError):
        continue
    for number, line in enumerate(text.splitlines(), 1):
        if PUSH.search(line):
            problems.append("%s:%d: drizzle-kit push is forbidden (generate and migrate only)" % (rel(path), number))
    if not path.endswith((".ts", ".mts", ".js", ".mjs", ".cjs")):
        continue
    offset = 0
    for statement in STATEMENT_SPLIT.split(text):
        line_no = text.count("\n", 0, offset) + 1 + len(statement) - len(statement.lstrip("\n"))
        offset += len(statement) + 1
        if not re.search(PK, statement) or "lint-db-allow" in statement:
            continue
        reasons = []
        if EMPTY_SELECT.search(statement) and re.search(r"\.from\(\s*" + PK + r"\b", statement):
            reasons.append("select() without a column projection")
        if EMPTY_RETURNING.search(statement) and re.search(r"\.(insert|update|delete)\(\s*" + PK + r"\b", statement):
            reasons.append("returning() without a column projection")
        if re.search(r"query\.\s*" + PK + r"\.find\w*\(", statement) and "columns" not in statement:
            reasons.append("relational query without columns")
        if re.search(r"getTableColumns\(\s*" + PK + r"\s*\)", statement):
            reasons.append("getTableColumns spreads every column")
        if (re.search(r"select\s+\*\s+from\s+(?:public\.)?provider_keys\b", statement, re.I) or\
           (re.search(r"\breturning\s+\*", statement, re.I) and re.search(r"provider_keys", statement))):
            reasons.append("SQL selects every column")
        for reason in reasons:
            problems.append("%s:%d: provider_keys %s (ciphertext, nonce and wrapped_dek must be projected explicitly)" % (rel(path), line_no, reason))

migrations = os.path.join(root, "apps", "api", "src", "database", "migrations")
if os.path.isdir(migrations):
    seen = {}
    for name in sorted(os.listdir(migrations)):
        if not name.endswith(".sql"):
            continue
        match = re.fullmatch(r"(\d{4})_task-\d{3}-[a-z0-9-]+\.sql", name)
        if not match:
            problems.append("%s: migration file name must be <NNNN>_task-<NNN>-<slug>.sql" % name)
        elif match.group(1) in seen:
            problems.append("%s: number %s is already used by %s" % (name, match.group(1), seen[match.group(1)]))
        else:
            seen[match.group(1)] = name

for problem in problems:
    print("lint-db: " + problem)
print("lint-db: %d problem(s)" % len(problems))
sys.exit(1 if problems else 0)
PY
