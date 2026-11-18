#!/usr/bin/env bash
# Install the pinned scanners into CI_TOOLS_DIR (default $XDG_CACHE_HOME/shroomap-ci-tools, else ~/.cache/shroomap-ci-tools). Checksums are verified.
# Usage: install-tools.sh [semgrep|python|gitleaks|osv-scanner|trivy ...]   (no argument installs all)
set -euo pipefail

TOOLS_DIR="${CI_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/shroomap-ci-tools}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GITLEAKS_VERSION=8.30.1
OSV_VERSION=2.7.1
TRIVY_VERSION=0.76.2
GET_PIP_TAG=26.0.1   # pypa/get-pip tag; the sha256 below is of its public/get-pip.py
GET_PIP_SHA256=feba1c697df45be1b539b40d93c102c9ee9dde1d966303323b830b06f3fbca3c
mkdir -p "$TOOLS_DIR/bin"

# Concurrent runs share the cache: one installer at a time; the others wait, then find the tools in place.
exec 9>"$TOOLS_DIR/.install.lock"
flock 9

# Place a binary atomically (copy beside the target, then rename) so a reader never sees a partial file.
place() { # src dest
  install -m 0755 "$1" "$2.tmp.$$" && mv -f "$2.tmp.$$" "$2"
}

verify() { # file expected-sha256
  echo "$2  $1" | sha256sum --check --status || { echo "checksum mismatch for $1" >&2; exit 1; }
}

fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }

install_python() {
  [ -x "$TOOLS_DIR/venv/bin/pip" ] && return 0
  rm -rf "$TOOLS_DIR/venv"   # a half-built venv from an interrupted run
  python3 -m venv --without-pip "$TOOLS_DIR/venv"
  local tmp; tmp="$(mktemp -d)"
  fetch "https://raw.githubusercontent.com/pypa/get-pip/${GET_PIP_TAG}/public/get-pip.py" "$tmp/get-pip.py"
  verify "$tmp/get-pip.py" "$GET_PIP_SHA256"
  "$TOOLS_DIR/venv/bin/python" "$tmp/get-pip.py" -q
  rm -rf "$tmp"
}

install_semgrep() {
  install_python
  "$TOOLS_DIR/venv/bin/pip" install -q --require-hashes -r "$HERE/requirements.txt"
}

install_gitleaks() {
  [ -x "$TOOLS_DIR/bin/gitleaks" ] && return 0
  local tmp base file; tmp="$(mktemp -d)"
  base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
  file="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  fetch "$base/$file" "$tmp/$file"; fetch "$base/gitleaks_${GITLEAKS_VERSION}_checksums.txt" "$tmp/sums"
  verify "$tmp/$file" "$(awk -v f="$file" '$2==f {print $1}' "$tmp/sums")"
  tar -xzf "$tmp/$file" -C "$tmp" gitleaks; place "$tmp/gitleaks" "$TOOLS_DIR/bin/gitleaks"; rm -rf "$tmp"
}

install_osv() {
  [ -x "$TOOLS_DIR/bin/osv-scanner" ] && return 0
  local tmp base; tmp="$(mktemp -d)"
  base="https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}"
  fetch "$base/osv-scanner_linux_amd64" "$tmp/osv-scanner"; fetch "$base/osv-scanner_SHA256SUMS" "$tmp/sums"
  verify "$tmp/osv-scanner" "$(awk '$2=="osv-scanner_linux_amd64" {print $1}' "$tmp/sums")"
  place "$tmp/osv-scanner" "$TOOLS_DIR/bin/osv-scanner"; rm -rf "$tmp"
}

install_trivy() {
  [ -x "$TOOLS_DIR/bin/trivy" ] && return 0
  local tmp base file; tmp="$(mktemp -d)"
  base="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}"
  file="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
  fetch "$base/$file" "$tmp/$file"; fetch "$base/trivy_${TRIVY_VERSION}_checksums.txt" "$tmp/sums"
  verify "$tmp/$file" "$(awk -v f="$file" '$2==f {print $1}' "$tmp/sums")"
  tar -xzf "$tmp/$file" -C "$tmp" trivy; place "$tmp/trivy" "$TOOLS_DIR/bin/trivy"; rm -rf "$tmp"
}

targets=("$@"); [ ${#targets[@]} -gt 0 ] || targets=(semgrep gitleaks osv-scanner trivy)
for t in "${targets[@]}"; do
  case "$t" in
    semgrep|python) install_semgrep ;;
    gitleaks) install_gitleaks ;;
    osv-scanner) install_osv ;;
    trivy) install_trivy ;;
    *) echo "unknown tool $t" >&2; exit 2 ;;
  esac
done
echo "tools ready in $TOOLS_DIR"
