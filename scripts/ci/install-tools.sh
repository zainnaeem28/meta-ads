#!/usr/bin/env bash
# Install the pinned scanners into CI_TOOLS_DIR (default ~/.cache/shroomap-ci-tools). Checksums are verified.
# Usage: install-tools.sh [semgrep|python|gitleaks|osv-scanner|trivy ...]   (no argument installs all)
set -euo pipefail

TOOLS_DIR="${CI_TOOLS_DIR:-$HOME/.cache/shroomap-ci-tools}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GITLEAKS_VERSION=8.30.1
OSV_VERSION=2.7.1
TRIVY_VERSION=0.76.2
mkdir -p "$TOOLS_DIR/bin"

verify() { # file expected-sha256
  echo "$2  $1" | sha256sum --check --status || { echo "checksum mismatch for $1" >&2; exit 1; }
}

fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }

install_python() {
  [ -x "$TOOLS_DIR/venv/bin/pip" ] && return 0
  python3 -m venv --without-pip "$TOOLS_DIR/venv"
  local tmp; tmp="$(mktemp -d)"
  fetch https://bootstrap.pypa.io/get-pip.py "$tmp/get-pip.py"
  "$TOOLS_DIR/venv/bin/python" "$tmp/get-pip.py" -q
  rm -rf "$tmp"
}

install_semgrep() {
  install_python
  "$TOOLS_DIR/venv/bin/pip" install -q -r "$HERE/requirements.txt"
}

install_gitleaks() {
  [ -x "$TOOLS_DIR/bin/gitleaks" ] && return 0
  local tmp base file; tmp="$(mktemp -d)"
  base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
  file="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  fetch "$base/$file" "$tmp/$file"; fetch "$base/gitleaks_${GITLEAKS_VERSION}_checksums.txt" "$tmp/sums"
  verify "$tmp/$file" "$(awk -v f="$file" '$2==f {print $1}' "$tmp/sums")"
  tar -xzf "$tmp/$file" -C "$TOOLS_DIR/bin" gitleaks; rm -rf "$tmp"
}

install_osv() {
  [ -x "$TOOLS_DIR/bin/osv-scanner" ] && return 0
  local tmp base; tmp="$(mktemp -d)"
  base="https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}"
  fetch "$base/osv-scanner_linux_amd64" "$tmp/osv-scanner"; fetch "$base/osv-scanner_SHA256SUMS" "$tmp/sums"
  verify "$tmp/osv-scanner" "$(awk '$2=="osv-scanner_linux_amd64" {print $1}' "$tmp/sums")"
  install -m 0755 "$tmp/osv-scanner" "$TOOLS_DIR/bin/osv-scanner"; rm -rf "$tmp"
}

install_trivy() {
  [ -x "$TOOLS_DIR/bin/trivy" ] && return 0
  local tmp base file; tmp="$(mktemp -d)"
  base="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}"
  file="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
  fetch "$base/$file" "$tmp/$file"; fetch "$base/trivy_${TRIVY_VERSION}_checksums.txt" "$tmp/sums"
  verify "$tmp/$file" "$(awk -v f="$file" '$2==f {print $1}' "$tmp/sums")"
  tar -xzf "$tmp/$file" -C "$TOOLS_DIR/bin" trivy; rm -rf "$tmp"
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
