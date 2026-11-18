#!/usr/bin/env bash
# Installs the baseline tools into CI_TOOLS_DIR (default ~/.cache/shroomap-ci-tools): k6, OWASP ZAP with a Temurin JRE,
# Lighthouse (npm, pinned) and the Playwright Chromium. Versions are pinned and downloads are checksum-verified.
# Usage: install-tools.sh [k6|zap|lighthouse|chromium ...]   (no argument installs all)
set -euo pipefail

TOOLS_DIR="${CI_TOOLS_DIR:-$HOME/.cache/shroomap-ci-tools}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
K6_VERSION=2.4.0
K6_SHA256=5a5ecf23529ccf93135bc7e5b0c1cd5126ecf5f2672e22eed1556a0ab74abb87
ZAP_VERSION=2.17.0
ZAP_SHA256=efe799aaa3627db683b43f00c9c210aea0b75c00cc8f0a0f0434d12bb3ddde5a
JRE_TAG='jdk-21.0.13%2B9'
JRE_FILE=OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz
JRE_SHA256=a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd
LIGHTHOUSE_VERSION=13.6.0
mkdir -p "$TOOLS_DIR/bin"

verify() { echo "$2  $1" | sha256sum --check --status || { echo "checksum mismatch for $1" >&2; exit 1; }; }
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }

install_k6() {
  [ -x "$TOOLS_DIR/bin/k6" ] && return 0
  local tmp; tmp="$(mktemp -d)"
  local file="k6-v${K6_VERSION}-linux-amd64.tar.gz"
  fetch "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/$file" "$tmp/$file"
  verify "$tmp/$file" "$K6_SHA256"
  tar -xzf "$tmp/$file" -C "$tmp"
  install -m 0755 "$tmp/k6-v${K6_VERSION}-linux-amd64/k6" "$TOOLS_DIR/bin/k6"; rm -rf "$tmp"
}

install_zap() {
  [ -x "$TOOLS_DIR/zap/ZAP_${ZAP_VERSION}/zap.sh" ] && return 0
  local tmp; tmp="$(mktemp -d)"
  if [ ! -x "$TOOLS_DIR/jre/bin/java" ]; then
    fetch "https://github.com/adoptium/temurin21-binaries/releases/download/${JRE_TAG}/${JRE_FILE}" "$tmp/jre.tgz"
    verify "$tmp/jre.tgz" "$JRE_SHA256"
    mkdir -p "$TOOLS_DIR/jre"; tar -xzf "$tmp/jre.tgz" -C "$TOOLS_DIR/jre" --strip-components=1
  fi
  fetch "https://github.com/zaproxy/zaproxy/releases/download/v${ZAP_VERSION}/ZAP_${ZAP_VERSION}_Linux.tar.gz" "$tmp/zap.tgz"
  verify "$tmp/zap.tgz" "$ZAP_SHA256"
  mkdir -p "$TOOLS_DIR/zap"; tar -xzf "$tmp/zap.tgz" -C "$TOOLS_DIR/zap"; rm -rf "$tmp"
}

install_lighthouse() {
  [ -x "$TOOLS_DIR/lighthouse/node_modules/.bin/lighthouse" ] && return 0
  mkdir -p "$TOOLS_DIR/lighthouse"
  # puppeteer-core 25.18.1 is listed by the registry but its tarball answers 404; the override pins the previous release.
  cat > "$TOOLS_DIR/lighthouse/package.json" <<JSON
{ "name": "lighthouse-baseline", "private": true, "dependencies": { "lighthouse": "${LIGHTHOUSE_VERSION}" },
  "overrides": { "puppeteer-core": "25.18.0" } }
JSON
  ( cd "$TOOLS_DIR/lighthouse" && npm install --no-audit --no-fund --ignore-scripts >&2 )
}

install_chromium() {
  ( cd "$ROOT/apps/web" && pnpm exec playwright install chromium >&2 )
}

targets=("$@"); [ ${#targets[@]} -gt 0 ] || targets=(k6 zap lighthouse chromium)
for t in "${targets[@]}"; do
  case "$t" in
    k6) install_k6 ;; zap) install_zap ;; lighthouse) install_lighthouse ;; chromium) install_chromium ;;
    *) echo "unknown tool $t" >&2; exit 2 ;;
  esac
done
echo "baseline tools ready in $TOOLS_DIR"
