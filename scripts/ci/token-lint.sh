#!/usr/bin/env bash
# Token lint (TASK-066, BRAND-BRIEF §4-§6, WORKFLOW Visual quality). Fails on, outside packages/ui/src/tokens.css:
#   raw-colour    hex colours and rgb()/hsl()/oklch()/... colour functions
#   arbitrary     arbitrary Tailwind values (w-[13px], [color:red]); the token form w-(--control-h) is allowed
#   spacing       px/rem/em literals (use spacing, size and radius tokens)
#   cdn-font      remote font or stylesheet URLs (fonts are self-hosted)
# Scans apps/*/src and packages/*/src (css, ts, tsx, js, jsx, mjs, html). A line may opt out with "token-lint-ignore".
# Usage: token-lint.sh [--root DIR] | --self-test   (--root scans DIR/{apps,packages}/*/src without git)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

scan() {
  local root="$1"
  python3 -I - "$root" <<'PY'
import os, re, sys
root = sys.argv[1]
EXT = {".css", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".html"}
RULES = [
    ("raw-colour", re.compile(r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(")),
    ("arbitrary", re.compile(r"(?:^|[\s\"'`:{(])!?-?[a-z][a-z0-9-]*-\[[^\]\s]+\]|\[[a-z-]+:[^\]\s]+\]")),
    ("spacing", re.compile(r"(?<![\w.#-])-?\d*\.?\d+(?:px|rem|em)\b")),
    ("cdn-font", re.compile(r"url\(\s*[\"']?https?:|@import\s+(?:url\()?[\"']?https?:|fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|fonts\.bunny\.net|cdn\.jsdelivr|unpkg\.com|cdnjs\.|next/font/google|<link[^>]+rel=[\"']?stylesheet[^>]+https?:", re.I)),
]
found = 0
for base in ("apps", "packages"):
    top = os.path.join(root, base)
    if not os.path.isdir(top):
        continue
    for pkg in sorted(os.listdir(top)):
        src = os.path.join(top, pkg, "src")
        for dirpath, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if d not in ("node_modules", ".next", "fonts")]
            for name in sorted(files):
                if os.path.splitext(name)[1] not in EXT:
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, root)
                if rel == "packages/ui/src/tokens.css":
                    continue
                with open(path, encoding="utf-8") as fh:
                    for no, line in enumerate(fh, 1):
                        if "token-lint-ignore" in line:
                            continue
                        for rule, rx in RULES:
                            if rule == "spacing" and re.search(r"@(media|container)\b", line):
                                continue
                            if rule == "spacing" and rel.endswith("theme.css") and "unicode-range" in line:
                                continue
                            m = rx.search(line)
                            if m:
                                found += 1
                                print(f"{rel}:{no}: {rule}: {m.group(0).strip()}")
print(f"token-lint: {found} violation(s)")
sys.exit(1 if found else 0)
PY
}

self_test() {
  local tmp rc=0 case
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/apps/web/src" "$tmp/packages/ui/src"
  printf ':root { --x: #fff; }\n' >"$tmp/packages/ui/src/tokens.css"
  printf 'export const A = () => <div className="p-4 bg-background w-(--control-h) text-body" />;\n' >"$tmp/apps/web/src/ok.tsx"
  scan "$tmp" >/dev/null || { echo "self-test: clean tree was rejected"; return 1; }
  declare -A bad=(
    [raw-hex]='export const c = "#1a2b3c";'
    [raw-rgb]='.a { color: rgb(1 2 3); }'
    [arbitrary]='export const A = () => <div className="w-[13px]" />;'
    [arbitrary-prop]='export const A = () => <div className="[color:red]" />;'
    [spacing]='.a { padding: 13px; }'
    [cdn-font]='@import url("https://fonts.googleapis.com/css2?family=Inter");'
    [cdn-font-face]='@font-face { src: url(https://cdn.example.com/inter.woff2); }'
    [next-font-google]="import { Inter } from 'next/font/google';"
  )
  for case in "${!bad[@]}"; do
    rm -f "$tmp"/apps/web/src/bad.*
    printf '%s\n' "${bad[$case]}" >"$tmp/apps/web/src/bad.${case%%-*}.tsx"
    [ "${bad[$case]:0:1}" = "." ] || [ "${bad[$case]:0:1}" = "@" ] && mv "$tmp/apps/web/src/bad.${case%%-*}.tsx" "$tmp/apps/web/src/bad.css"
    if scan "$tmp" >/dev/null; then echo "self-test: '$case' was NOT rejected"; rc=1; else echo "self-test: '$case' rejected"; fi
  done
  rm -f "$tmp"/apps/web/src/bad.*
  # token files are the only place for raw colours: the same hex in the token file passes
  scan "$tmp" >/dev/null || { echo "self-test: token file exemption broken"; rc=1; }
  return $rc
}

case "${1:-}" in
  --self-test) self_test ;;
  --root) scan "$2" ;;
  "") scan "$HERE" && self_test >/dev/null ;;
  *) echo "usage: token-lint.sh [--root DIR | --self-test]" >&2; exit 2 ;;
esac
